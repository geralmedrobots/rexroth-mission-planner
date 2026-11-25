import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { normalizeAngle } from '../geometry/angles';
import type {
  MotionAction, MotionCostComponents, MotionDirection, MotionPlan, MotionState,
} from '../motion/planningModel';
import { measureMotionPlan } from '../motion/MotionPlanMetrics';
import type { PlannerRequest } from '../planner/PlannerService';
import { MotionPlanValidator } from '../planner/MotionPlanValidator';
import { PassageDetector } from '../planner/PassageDetector';
import { PoseCollisionChecker } from '../planner/PoseCollisionChecker';
import { RotationSweepChecker } from '../planner/RotationSweepChecker';
import { TranslationSweepChecker } from '../planner/TranslationSweepChecker';
import type {
  OccupancyGrid, PathPoint, PlannerDiagnostics, PlannerResult, RobotFootprint,
} from '../types';
import { CostModel } from './CostModel';
import { directionPreference, preparationContext, DIRECTION_PREFERENCE_SEMANTICS } from './DirectionPreference';
import { MotionPlanOptimiser } from './MotionPlanOptimiser';
import { MotionStateGuide } from './MotionStateGuide';
import { LONG_TRANSLATION_PRIMITIVES_M, MotionStateRefinement,
  type RefinementMode } from './MotionStateRefinement';
import { createPlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';
import {
  MOTION_STATE_HEADING_BINS, MOTION_STATE_HEADING_STEP_RAD,
  type EffectiveMotionStateConfiguration,
} from './MotionStateConfiguration';
import { createMotionPlannerCalibrationSnapshot } from './MotionPlannerCalibration';

export { MOTION_STATE_HEADING_BINS, MOTION_STATE_HEADING_STEP_RAD } from './MotionStateConfiguration';

/** Search-only policy; physical costs and feasibility configuration are unchanged. */
export const MOTION_STATE_SEARCH_POLICY = Object.freeze({
  heuristicWeight: 1.25,
  corridorWidthsM: [1.25, 2.5] as const,
  corridorBudgetFractions: [.12, .30] as const,
  analyticConnectorEveryExpansions: 24,
  analyticConnectorMaximumDistanceM: 12,
  longTranslationPrimitivesM: LONG_TRANSLATION_PRIMITIVES_M,
});

/**
 * Sixteen bins provide a 22.5 degree angular resolution. This is fine enough
 * to represent useful approach orientations on the current occupancy grids,
 * while keeping the x/y/theta/direction lattice bounded. Translation is always
 * along the exact body axis; heading bins identify search states, not bearings
 * inferred from an XY path.
 */
export interface MotionPlannerDiagnosticEvent extends Record<string, unknown> {
  eventType: string;
}

interface SearchState extends MotionState {
  row: number;
  column: number;
  thetaBin: number;
  positionKey?: string;
  refinementMode?: RefinementMode;
}

interface SearchNode {
  state: SearchState;
  g: number;
  preferenceCost?: number;
  h: number;
  f: number;
  parent?: SearchNode;
  action?: MotionAction;
}

interface TerminalCandidate {
  states: MotionState[];
  actions: MotionAction[];
  cost: number;
  selection?: Record<string, unknown>;
}

interface Permissions {
  forward: boolean;
  reverse: boolean;
  rotate: boolean;
}

interface TransitionCounts {
  candidates: number; rejected: number; translationCollisions: number; rotationCollisions: number;
  primitiveAttempts: Record<string, number>;
  primitiveCollisions: Record<string, number>;
  primitiveClearanceRejections: Record<string, number>;
  primitiveAccepted: Record<string, number>;
  primitivePruned: Record<string, number>;
  generatedStatesByMode: Record<RefinementMode, number>;
  minimumRefinementClearanceM: number | null;
  connectorTranslationCollisions: number;
  connectorClearanceRejections: number;
}
const transitionCounts = (): TransitionCounts => ({ candidates: 0, rejected: 0,
  translationCollisions: 0, rotationCollisions: 0, primitiveAttempts: {}, primitiveCollisions: {},
  primitiveClearanceRejections: {}, primitiveAccepted: {}, primitivePruned: {},
  generatedStatesByMode: { normal: 0, medium: 0, tight: 0 }, minimumRefinementClearanceM: null,
  connectorTranslationCollisions: 0, connectorClearanceRejections: 0 });
const increment = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

class NodeHeap {
  private readonly values: SearchNode[] = [];
  private less(left: SearchNode, right: SearchNode): boolean {
    return left.f < right.f || (left.f === right.f && left.h < right.h);
  }
  public push(value: SearchNode): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.less(value, this.values[parent]!)) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }
  public pop(): SearchNode | undefined {
    const root = this.values[0];
    const tail = this.values.pop();
    if (!root || !tail || !this.values.length) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child = right < this.values.length && this.less(this.values[right]!, this.values[left]!) ? right : left;
      if (!this.less(this.values[child]!, tail)) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = tail;
    return root;
  }
  public peek(): SearchNode | undefined { return this.values[0]; }
  public get size(): number { return this.values.length; }
}

const headingBin = (theta: number): number => {
  const raw = Math.round(normalizeAngle(theta) / MOTION_STATE_HEADING_STEP_RAD);
  return ((raw % MOTION_STATE_HEADING_BINS) + MOTION_STATE_HEADING_BINS) % MOTION_STATE_HEADING_BINS;
};
const binHeading = (bin: number): number => normalizeAngle(bin * MOTION_STATE_HEADING_STEP_RAD);
const stateKey = (state: SearchState): string =>
  `${state.positionKey ?? `${state.row},${state.column}`},${state.thetaBin},${state.direction}`;
const angleDistance = (left: number, right: number): number =>
  Math.abs(normalizeAngle(left - right));
const zeroCost = (): MotionCostComponents => ({
  distance: 0, rotation: 0, reverse: 0, directionSwitch: 0,
  wallClearance: 0, narrowPassage: 0, turnLocation: 0,
  terminalOrientation: 0, total: 0,
});
const sumCost = (components: MotionCostComponents): number =>
  components.distance + components.rotation + components.reverse +
  components.directionSwitch + components.wallClearance +
  components.narrowPassage + components.turnLocation + components.terminalOrientation;

export class MotionStatePlanner {
  public plan(request: PlannerRequest): PlannerResult {
    const started = performance.now();
    const grid = request.collisionGrid ?? request.grid;
    const configuration = request.planningConfiguration ?? createPlanningConfigurationSnapshot({
      plannerOptions: request.options, footprint: request.footprint,
    });
    const options = configuration.planner;
    const motionConfiguration = configuration.normalized.motionState;
    const sourceFootprint = configuration.footprint;
    const footprint = structuredClone(sourceFootprint) as RobotFootprint;
    footprint.safetyMargin = motionConfiguration.footprint.effectiveSafetyMarginM;
    const permissions: Permissions = {
      forward: motionConfiguration.permissions.forward,
      reverse: motionConfiguration.permissions.reverse,
      rotate: motionConfiguration.permissions.rotateInPlace,
    };
    const transform = new CoordinateTransformer(grid.metadata);
    const startCellWorld = transform.gridToWorld(request.start.row, request.start.column);
    const goalCellWorld = transform.gridToWorld(request.goal.row, request.goal.column);
    const startPose = request.exactStartPose ?? { ...startCellWorld, theta: request.startTheta ?? 0 };
    const goalPose = request.exactGoalPose ?? { ...goalCellWorld, theta: request.goalTheta ?? 0 };
    const poseChecker = new PoseCollisionChecker(grid);
    const rotationChecker = new RotationSweepChecker(poseChecker);
    const translationChecker = new TranslationSweepChecker(poseChecker);
    const events: MotionPlannerDiagnosticEvent[] = [];
    const eventCounts = transitionCounts();
    const searchDiagnostics: Record<string, unknown> = {};
    const emit = (eventType: string, payload: Record<string, unknown> = {}): void => {
      const critical = eventType === 'motionplanner.started' ||
        eventType === 'motionplanner.goal.reached' || eventType === 'motionplanner.failed' ||
        eventType === 'motionplan.created' || eventType === 'motionplan.optimised' ||
        eventType === 'motionplan.selected.summary' || eventType.startsWith('motionplan.validation.') ||
        eventType === 'motionplanner.calibration.snapshot' ||
        eventType === 'motionplanner.guide.created' ||
        eventType === 'motionplanner.analyticConnector.succeeded' ||
        eventType === 'motionplanner.corridor.started' ||
        eventType === 'motionplanner.corridor.completed' ||
        eventType === 'motionplanner.completed' ||
        (eventType === 'motionplanner.state.expanded' && payload.final === true);
      if (critical || events.length < 140) events.push({ eventType, ...payload });
    };
    emit('motionplanner.started', {
      planner: 'motion-state', headingBins: MOTION_STATE_HEADING_BINS,
      angularResolutionRad: MOTION_STATE_HEADING_STEP_RAD, angularResolutionDeg: 22.5,
      permissions, effectiveConfiguration: motionConfiguration,
    });

    const complete = (result: PlannerResult): PlannerResult => {
      const snapshot = createMotionPlannerCalibrationSnapshot({
        grid, footprint, startPose, goalPose,
        goalTheta: request.goalTheta, configuration: motionConfiguration, result,
      });
      result.motionPlannerCalibration = snapshot;
      emit('motionplanner.calibration.snapshot', { snapshot });
      // Include optimiser, passage annotations AND calibration/metrics in wall time.
      result.statistics.durationMs = performance.now() - started;
      const selected = result.motionPlan?.diagnostics?.selected as Record<string, unknown> | undefined;
      if (selected) selected.planningDurationMs = result.statistics.durationMs;
      result.motionPlannerCalibration = { ...snapshot, result: { ...snapshot.result,
        planningDurationMs: result.statistics.durationMs } };
      emit('motionplanner.completed', { ...searchDiagnostics, ...eventCounts,
        success: result.success, failureCode: result.diagnostics?.physicalFailureCode,
        reason: result.error, durationMs: result.statistics.durationMs,
        expanded: result.statistics.visitedCells });
      return result;
    };
    const fail = (error: string, expanded: number, code = 'NO_PHYSICALLY_VALID_ROUTE'): PlannerResult => {
      emit('motionplanner.state.expanded', { expanded, final: true, ...eventCounts });
      emit('motionplanner.failed', { reason: error, code, expanded, ...searchDiagnostics });
      const diagnostics = this.diagnostics(false, error, code, expanded, []);
      return complete({
        success: false, error, rawPath: [], simplifiedPath: [], finalPath: [], baselinePath: [],
        diagnostics, motionPlannerEvents: events,
        statistics: { visitedCells: expanded, durationMs: performance.now() - started,
          rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 },
      });
    };
    if (!permissions.forward && !permissions.reverse) return fail('Neither forward nor reverse translation is permitted.', 0, 'NO_SAFE_MANOEUVRE_SPACE');
    if (!poseChecker.pointIsFree(grid, startPose, footprint)) return fail('The complete footprint collides at the exact start pose.', 0, 'START_NOT_FREE');
    if (request.goalTheta !== undefined && !poseChecker.pointIsFree(grid,
      { ...goalPose, theta: request.goalTheta }, footprint))
      return fail('The requested final pose is not collision free.', 0, 'GOAL_NOT_FREE');

    const startCell = transform.worldToGrid(startPose.x, startPose.y);
    if (!startCell) return fail('The exact start pose is outside the occupancy grid.', 0, 'START_NOT_FREE');
    const guideBuilder = new MotionStateGuide();
    const guide = guideBuilder.build(grid, startCell, request.goal, footprint,
      motionConfiguration);
    const clearance = guide.clearance;
    const refinement = new MotionStateRefinement(footprint, motionConfiguration, grid.metadata.resolution);
    Object.assign(searchDiagnostics, { refinementMediumClearanceM: refinement.mediumClearanceM,
      refinementTightClearanceM: refinement.tightClearanceM,
      refinedPositionResolutionM: refinement.positionResolutionM });
    emit('motionplanner.guide.created', { durationMs: guide.durationMs,
      lengthM: guide.lengthM, pointCount: guide.cells.length,
      cache: guide.cacheHit ? 'hit' : 'miss', resolutionM: guide.resolutionM,
      preprocessingMs: guide.preprocessingMs, astarMs: guide.searchMs,
      heuristicMs: guide.heuristicMs, expandedCells: guide.expandedCells,
      heuristicExpandedCells: guide.heuristicExpandedCells,
      heuristicCacheHit: guide.heuristicCacheHit, status: guide.status });
    Object.assign(searchDiagnostics, { guideDurationMs: guide.durationMs,
      guidePreprocessingMs: guide.preprocessingMs, guideSearchMs: guide.searchMs,
      guideResolutionM: guide.resolutionM, guideStatus: guide.status,
      guideCache: guide.cacheHit ? 'hit' : 'miss' });
    if (this.clearanceAt(startPose, transform, clearance) + 1e-9 <
      motionConfiguration.clearance.hardMinimumM)
      return fail('The exact start pose is below the configured hard minimum clearance.', 0, 'START_NOT_FREE');
    const initialDirection: MotionDirection = permissions.forward ? 'FORWARD' : 'REVERSE';
    const initial: SearchState = {
      x: startPose.x, y: startPose.y, theta: normalizeAngle(startPose.theta),
      thetaBin: headingBin(startPose.theta), direction: initialDirection,
      row: startCell.row, column: startCell.column,
    };
    this.refineState(initial, refinement, transform, clearance);
    const heuristicPriorityWeight = MOTION_STATE_SEARCH_POLICY.heuristicWeight;
    const heuristic = (state: SearchState): number => {
      const guidedDistance = guide.distanceToGoal(state);
      const distance = Number.isFinite(guidedDistance) ? guidedDistance! :
        Math.hypot(state.x - goalPose.x, state.y - goalPose.y);
      return CostModel.distance(distance, motionConfiguration.weights.translationCostPerM);
    };
    let expanded = 0;
    let analyticConnectorAttempts = 0;
    let analyticConnectorSuccesses = 0;
    let corridorWidthUsedM: number | undefined;
    let unrestrictedFallbackRequired = false;
    let bestGoal: { node: SearchNode; terminal: TerminalCandidate; total: number } | undefined;
    const exploredClearanceCandidates: Array<{
      clearanceM: number; accumulatedCost: number; actionType: string;
      x: number; y: number; direction: MotionDirection;
    }> = [];
    const expansionLimit = grid.metadata.width * grid.metadata.height *
      MOTION_STATE_HEADING_BINS * 2;
    // Guide has its own 150 ms target; SE(2) gets its full configured budget.
    const searchStarted = performance.now();
    const searchDeadline = searchStarted + motionConfiguration.maximumPlanningTimeMs;
    const corridorStages: Array<{ widthM?: number; mask?: Uint8Array; deadline: number }> =
      guide.cells.length ? [
        { widthM: MOTION_STATE_SEARCH_POLICY.corridorWidthsM[0],
          mask: guideBuilder.corridorMask(grid, guide.cells,
            MOTION_STATE_SEARCH_POLICY.corridorWidthsM[0]),
          deadline: searchStarted + motionConfiguration.maximumPlanningTimeMs *
            MOTION_STATE_SEARCH_POLICY.corridorBudgetFractions[0] },
        { widthM: MOTION_STATE_SEARCH_POLICY.corridorWidthsM[1],
          mask: guideBuilder.corridorMask(grid, guide.cells,
            MOTION_STATE_SEARCH_POLICY.corridorWidthsM[1]),
          deadline: searchStarted + motionConfiguration.maximumPlanningTimeMs *
            MOTION_STATE_SEARCH_POLICY.corridorBudgetFractions[1] },
        { deadline: searchDeadline },
      ] : [{ deadline: searchDeadline }];
    let unrestrictedExhausted = false;
    let unrestrictedExpanded = 0;

    for (const stage of corridorStages) {
      const stageStarted = performance.now();
      if (stageStarted >= searchDeadline) break;
      if (stage.widthM === undefined) unrestrictedFallbackRequired = guide.cells.length > 0;
      emit('motionplanner.corridor.started', { widthM: stage.widthM ?? null,
        unrestricted: stage.widthM === undefined,
        remainingSearchBudgetMs: Math.max(0, searchDeadline - stageStarted),
        stageBudgetMs: Math.max(0, stage.deadline - stageStarted) });
      const open = new NodeHeap();
      const firstH = heuristic(initial);
      open.push({ state: initial, g: 0, h: firstH,
        f: firstH * heuristicPriorityWeight });
      const best = new Map<string, number>([[stateKey(initial), 0]]);
      let stageExpanded = 0;
      let stageGoal: typeof bestGoal;
      while (open.size && expanded < expansionLimit && performance.now() < stage.deadline) {
        const node = open.pop()!;
        if (node.g !== best.get(stateKey(node.state))) continue;
        const terminalOrientationCost = stageGoal?.terminal.actions.reduce((total, action) =>
          total + (action.costComponents?.terminalOrientation ?? 0), 0) ?? 0;
        if (stageGoal && node.f >= stageGoal.total - terminalOrientationCost - 1e-9) break;
        expanded += 1; stageExpanded += 1;
        if (expanded % 100 === 0) emit('motionplanner.state.expanded', {
          expanded, open: open.size, corridorWidthM: stage.widthM ?? null, ...eventCounts });

        const connectorDue = stageExpanded === 1 || stageExpanded %
          MOTION_STATE_SEARCH_POLICY.analyticConnectorEveryExpansions === 0;
        const connectorRange = Math.hypot(node.state.x - goalPose.x, node.state.y - goalPose.y);
        if (connectorDue && connectorRange <=
          MOTION_STATE_SEARCH_POLICY.analyticConnectorMaximumDistanceM) {
          analyticConnectorAttempts += 1;
          const terminal = this.terminalCandidate(node.state, goalPose, request.goalTheta,
            permissions, grid, footprint, motionConfiguration, clearance, rotationChecker,
            translationChecker, emit, eventCounts, configuration.order.allowedDeviationXy);
          if (terminal) analyticConnectorSuccesses += 1;
          if (terminal && (!stageGoal || node.g + (node.preferenceCost ?? 0) + terminal.cost < stageGoal.total)) {
            stageGoal = { node, terminal, total: node.g + (node.preferenceCost ?? 0) + terminal.cost };
            emit('motionplanner.analyticConnector.succeeded', { expanded,
              totalCost: stageGoal.total, distanceM: connectorRange });
          }
        }
        if (node.state.row === request.goal.row && node.state.column === request.goal.column) {
          const terminal = this.terminalCandidate(node.state, goalPose, request.goalTheta,
            permissions, grid, footprint, motionConfiguration, clearance, rotationChecker,
            translationChecker, emit, eventCounts, configuration.order.allowedDeviationXy);
          if (terminal && (!stageGoal || node.g + (node.preferenceCost ?? 0) + terminal.cost < stageGoal.total))
            stageGoal = { node, terminal, total: node.g + (node.preferenceCost ?? 0) + terminal.cost };
        }

        for (const candidate of this.transitions(node.state, permissions, grid, footprint,
          motionConfiguration, clearance, rotationChecker, translationChecker, transform,
          emit, eventCounts, refinement, (state, cost) => (!stage.mask ||
            stage.mask[state.row * grid.metadata.width + state.column] === 1) &&
            node.g + cost + 1e-9 < (best.get(stateKey(state)) ?? Infinity))) {
          if (stage.mask && !stage.mask[candidate.state.row * grid.metadata.width +
            candidate.state.column]) continue;
          // Lattice dominance uses physical cost; preference is evaluated on
          // complete route candidates so detours have no global-goal bias.
          const g = node.g + candidate.action.costComponents!.total - candidate.action.costComponents!.directionSwitch;
          const preferenceCost = (node.preferenceCost ?? 0) + candidate.action.costComponents!.directionSwitch;
          const key = stateKey(candidate.state);
          if (g + 1e-9 >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
          best.set(key, g);
          eventCounts.generatedStatesByMode[candidate.state.refinementMode ?? 'normal'] += 1;
          const candidateClearance = candidate.action.metadata?.clearanceM;
          if (typeof candidateClearance === 'number' && Number.isFinite(candidateClearance)) {
            exploredClearanceCandidates.push({ clearanceM: candidateClearance,
              accumulatedCost: g, actionType: candidate.action.type,
              x: candidate.state.x, y: candidate.state.y,
              direction: candidate.state.direction });
            exploredClearanceCandidates.sort((left, right) =>
              right.clearanceM - left.clearanceM || left.accumulatedCost - right.accumulatedCost);
            if (exploredClearanceCandidates.length > 8) exploredClearanceCandidates.length = 8;
          }
          const h = heuristic(candidate.state);
          open.push({ state: candidate.state, action: candidate.action, parent: node,
            g, preferenceCost, h, f: g + h * heuristicPriorityWeight });
        }
      }
      emit('motionplanner.corridor.completed', { widthM: stage.widthM ?? null,
        expanded: stageExpanded, found: Boolean(stageGoal),
        durationMs: performance.now() - stageStarted,
        remainingSearchBudgetMs: Math.max(0, searchDeadline - performance.now()),
        termination: stageGoal ? 'plan-found' : !open.size ? 'frontier-exhausted' :
          expanded >= expansionLimit ? 'expansion-limit' : 'stage-timeout' });
      if (stage.widthM === undefined) {
        unrestrictedExhausted = open.size === 0;
        unrestrictedExpanded = stageExpanded;
      }
      if (stageGoal) {
        bestGoal = stageGoal; corridorWidthUsedM = stage.widthM; break;
      }
    }
    Object.assign(searchDiagnostics, { searchDurationMs: performance.now() - searchStarted,
      searchBudgetMs: motionConfiguration.maximumPlanningTimeMs, analyticConnectorAttempts,
      analyticConnectorSuccesses, unrestrictedExpanded, unrestrictedFallbackRequired });
    if (!bestGoal) {
      const timedOut = !unrestrictedExhausted;
      return fail(timedOut ? 'Motion-state planning timed out before finding a physically feasible plan.' :
        'No physically feasible MotionPlan exists for the requested pose.', expanded,
      timedOut ? 'MOTION_STATE_SEARCH_TIMEOUT' : 'NO_PHYSICALLY_VALID_ROUTE');
    }
    emit('motionplanner.goal.reached', { expanded, totalCost: bestGoal.total,
      corridorWidthM: corridorWidthUsedM ?? null });

    const states: MotionState[] = [];
    const actions: MotionAction[] = [];
    let cursor: SearchNode | undefined = bestGoal.node;
    while (cursor) {
      states.unshift({ ...cursor.state });
      if (cursor.action) actions.unshift(cursor.action);
      cursor = cursor.parent;
    }
    states.push(...bestGoal.terminal.states);
    actions.push(...bestGoal.terminal.actions);
    const longPrimitiveTransitions = actions.filter((action) =>
      Number(action.metadata?.primitiveDistanceM) > grid.metadata.resolution + 1e-9).length;
    const totalCost = actions.reduce((total, action) => total + (action.costComponents?.total ?? 0), 0);
    const selectedPlan: MotionPlan = {
      states, actions,
      metadata: {
        source: 'motion-state-planner', plannerVersion: 'stage-6-hierarchical', cost: totalCost,
        directionCostSemantics: DIRECTION_PREFERENCE_SEMANTICS,
        headingBins: MOTION_STATE_HEADING_BINS, angularResolutionDeg: 22.5,
      },
      diagnostics: { expanded, eventCounts, events },
    };
    const selectedDecisionEvidence = this.selectedDecisionEvidence(selectedPlan,
      permissions, grid, footprint, motionConfiguration, clearance, rotationChecker,
      translationChecker, transform);
    const optimisation = new MotionPlanOptimiser().optimise(
      selectedPlan, grid, footprint, motionConfiguration, request.goalTheta,
    );
    const plan = optimisation.plan;
    const endpoint = plan.states.at(-1)!;
    const allowedGoalError = request.goalTheta === undefined &&
      Number.isFinite(configuration.order.allowedDeviationXy) ?
      Math.max(0, configuration.order.allowedDeviationXy) : 0;
    if (Math.hypot(endpoint.x - goalPose.x, endpoint.y - goalPose.y) > allowedGoalError + 1e-7)
      return fail('Selected MotionPlan is outside the requested goal-position tolerance.', expanded);
    const validation = new MotionPlanValidator().validate(
      plan, grid, footprint, motionConfiguration.sampling.translationCollisionIntervalM,
      motionConfiguration.sampling.rotationCollisionIntervalRad,
      permissions.reverse, request.goalTheta,
    );
    if (!validation.valid) {
      emit('motionplan.validation.failed', { issues: validation.issues });
      return fail(`Selected MotionPlan failed independent validation: ${validation.errors.join(' ')}`, expanded);
    }
    emit('motionplan.optimised', {
      inputStateCount: states.length, outputStateCount: plan.states.length,
      inputActionCount: actions.length, outputActionCount: plan.actions.length,
      candidatesConsidered: optimisation.candidatesConsidered,
      candidatesAccepted: optimisation.candidatesAccepted,
      candidatesRejectedByValidation: optimisation.candidatesRejectedByValidation,
      candidatesRejectedByClearance: optimisation.candidatesRejectedByClearance,
      rotationChangeRad: optimisation.metrics.totalAbsoluteRotationRad -
        optimisation.inputMetrics.totalAbsoluteRotationRad,
      rotationActionChange: optimisation.metrics.rotationActionCount -
        optimisation.inputMetrics.rotationActionCount,
    });
    emit('motionplan.validation.passed', { stateCount: plan.states.length,
      actionCount: plan.actions.length, afterOptimisation: true });
    emit('motionplanner.state.expanded', { expanded, final: true, ...eventCounts });
    const selectedMetrics = measureMotionPlan(plan, grid,
      motionConfiguration.sampling.translationCollisionIntervalM,
      64, clearance);
    plan.metadata = { ...plan.metadata, cost: selectedMetrics.costs.total };
    const durationMs = performance.now() - started;
    const selectedDiagnostic = {
      plannerMode: 'motion-state', planningDurationMs: durationMs, expandedStates: expanded,
      selectedTotalCost: selectedMetrics.costs.total,
      terminalConnectorSelection: bestGoal.terminal.selection,
      translationCost: selectedMetrics.costs.distance,
      rotationCost: selectedMetrics.costs.rotation,
      reverseCost: selectedMetrics.costs.reverse,
      directionSwitchCost: selectedMetrics.costs.directionSwitch,
      directionPreferenceCost: selectedMetrics.costs.directionSwitch,
      directionCostSemantics: DIRECTION_PREFERENCE_SEMANTICS,
      directionPreferenceSearchPolicy: 'physical-lattice-search-full-route-preference-evaluation',
      clearanceWallCost: selectedMetrics.costs.wallClearance,
      narrowPassageCost: selectedMetrics.costs.narrowPassage,
      turnLocationCost: selectedMetrics.costs.turnLocation,
      terminalOrientationCost: selectedMetrics.costs.terminalOrientation,
      totalPathLengthM: selectedMetrics.totalTranslationDistanceM,
      reversePathLengthM: selectedMetrics.totalReverseDistanceM,
      totalAbsoluteRotationRad: selectedMetrics.totalAbsoluteRotationRad,
      totalAbsoluteRotationDeg: selectedMetrics.totalAbsoluteRotationDeg,
      rotationActionCount: selectedMetrics.rotationActionCount,
      translationActionCount: selectedMetrics.translationActionCount,
      directionChangeCount: selectedMetrics.directionSwitchCount,
      minimumClearanceM: selectedMetrics.minimumClearanceM,
      averageClearanceM: selectedMetrics.averageClearanceM,
      actionSequence: selectedMetrics.actionSequenceSummary,
      actionSequenceTruncated: selectedMetrics.actionSequenceTruncated,
      guideDurationMs: guide.durationMs,
      ...searchDiagnostics,
      guideLengthM: guide.lengthM,
      guideCache: guide.cacheHit ? 'hit' : 'miss',
      corridorWidthUsedM: corridorWidthUsedM ?? null,
      weightedHeuristic: heuristicPriorityWeight,
      analyticConnectorAttempts,
      analyticConnectorSuccesses,
      longPrimitiveTransitions,
      unrestrictedFallbackRequired,
      selectedDecisionEvidence,
      clearanceDistanceTradeoff: {
        selectedDistanceM: selectedMetrics.totalTranslationDistanceM,
        selectedMinimumClearanceM: selectedMetrics.minimumClearanceM,
        selectedAverageClearanceM: selectedMetrics.averageClearanceM,
        selectedWallClearanceCost: selectedMetrics.costs.wallClearance,
        higherClearanceTransitionConsidered: exploredClearanceCandidates.some((candidate) =>
          candidate.clearanceM > selectedMetrics.averageClearanceM + grid.metadata.resolution / 2),
        competingTransitionSamples: exploredClearanceCandidates,
      },
    };
    emit('motionplan.selected.summary', selectedDiagnostic);
    emit('motionplan.created', { stateCount: plan.states.length,
      actionCount: plan.actions.length, totalCost: selectedMetrics.costs.total });
    plan.diagnostics = { ...plan.diagnostics, expanded, eventCounts, selected: selectedDiagnostic, events };
    const path: PathPoint[] = plan.states.map(({ x, y, theta }) => ({ x, y, theta }));
    const passages = new PassageDetector().detect(grid, path, footprint, options);
    const diagnostics = this.diagnostics(true, undefined, undefined, expanded, passages);
    diagnostics.minimumRouteClearanceM = selectedMetrics.minimumClearanceM;
    diagnostics.averageRouteClearanceM = selectedMetrics.averageClearanceM;
    diagnostics.largestHeadingChangeDeg = plan.actions.reduce((largest, action) =>
      Math.max(largest, (action.rotationRad ?? 0) * 180 / Math.PI), 0);
    return complete({
      success: true, rawPath: path, simplifiedPath: path, baselinePath: path,
      finalPath: path, motionPlan: plan, motionPlannerEvents: events, diagnostics,
      statistics: { visitedCells: expanded, durationMs,
        rawPointCount: path.length, simplifiedPointCount: path.length, finalPointCount: path.length },
    });
  }

  private transitions(
    state: SearchState,
    permissions: Permissions,
    grid: OccupancyGrid,
    footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration,
    clearance: Float32Array,
    rotation: RotationSweepChecker,
    translation: TranslationSweepChecker,
    transform: CoordinateTransformer,
    emit: (eventType: string, payload?: Record<string, unknown>) => void,
    counts: TransitionCounts,
    refinement: MotionStateRefinement,
    worthChecking: (state: SearchState, cost: number) => boolean = () => true,
  ): Array<{ state: SearchState; action: MotionAction }> {
    const result: Array<{ state: SearchState; action: MotionAction }> = [];
    const stateClearance = this.clearanceAt(state, transform, clearance);
    const mode = refinement.mode(stateClearance);
    if (mode !== 'normal') counts.minimumRefinementClearanceM = Math.min(
      counts.minimumRefinementClearanceM ?? Infinity, stateClearance);
    if (permissions.rotate) for (const delta of [-1, 1]) {
      const thetaBin = (state.thetaBin + delta + MOTION_STATE_HEADING_BINS) % MOTION_STATE_HEADING_BINS;
      const theta = binHeading(thetaBin);
      const next: SearchState = { ...state, theta, thetaBin,
        directionPreferenceContext: preparationContext(state) };
      const cost = this.rotationCost(angleDistance(theta, state.theta), stateClearance,
        configuration, grid.metadata.resolution, false);
      if (!worthChecking(next, cost.total)) continue;
      counts.candidates += 1;
      emit('motionplanner.transition.candidate', { transitionType: 'ROTATE_IN_PLACE', from: stateKey(state), thetaBin });
      if (stateClearance + 1e-9 < configuration.clearance.hardMinimumM) {
        counts.rejected += 1;
        emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE',
          reason: 'HARD_MINIMUM_CLEARANCE', from: stateKey(state), thetaBin,
          clearanceM: stateClearance });
        continue;
      }
      if (!rotation.rotationIsFree(grid, state, state.theta, theta, footprint,
        configuration.sampling.rotationCollisionIntervalRad)) {
        counts.rejected += 1; counts.rotationCollisions += 1;
        emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE', reason: 'ROTATION_SWEEP_COLLISION', from: stateKey(state), thetaBin });
        emit('collision.rotation.sweep', { from: stateKey(state), fromTheta: state.theta, toTheta: theta });
        continue;
      }
      emit('motionplanner.transition.accepted', { transitionType: 'ROTATE_IN_PLACE',
        from: stateKey(state), to: stateKey(next), costComponents: cost });
      result.push({ state: next, action: { type: 'ROTATE_IN_PLACE', from: state, to: next,
        rotationRad: angleDistance(theta, state.theta), costComponents: cost,
        metadata: { feasibility: 'rotation-sweep-passed', clearanceM: stateClearance } } });
    }

    const translationPermitted = state.direction === 'FORWARD' ? permissions.forward : permissions.reverse;
    if (translationPermitted) {
      const sign = state.direction === 'FORWARD' ? 1 : -1;
      const distances = refinement.distances(mode, grid.metadata.resolution);
      for (const distance of distances) {
        const lengthKey = distance.toFixed(3);
        const target = { x: state.x + sign * Math.cos(state.theta) * distance,
          y: state.y + sign * Math.sin(state.theta) * distance };
        const cell = transform.worldToGrid(target.x, target.y);
        if (!cell) {
          increment(counts.primitiveAttempts, lengthKey);
          increment(counts.primitiveCollisions, lengthKey);
          counts.candidates += 1; counts.rejected += 1; counts.translationCollisions += 1;
          continue;
        }
        const next: SearchState = { ...target, theta: state.theta, thetaBin: state.thetaBin,
          direction: state.direction, row: cell.row, column: cell.column,
          directionPreferenceContext: { heading: state.theta, direction: state.direction, translating: true } };
        this.refineState(next, refinement, transform, clearance);
        const type = state.direction === 'FORWARD' ? 'TRANSLATE_FORWARD' : 'TRANSLATE_REVERSE';
        // Compute the same physical cost before the expensive footprint sweep.
        // A dominated state or an endpoint outside this advisory corridor never
        // enters the frontier, so collision replay cannot change the decision.
        const transitionClearance = this.minimumSegmentClearance(state, next, grid,
          transform, clearance, configuration.sampling.translationCollisionIntervalM);
        // Refine on approach too: a long sweep can reach a tight area before
        // its source does. Reuse the clearance samples even if that sweep is
        // subsequently rejected, retaining shorter safe stopping positions.
        const approachMode = refinement.mode(transitionClearance);
        if (approachMode !== 'normal') {
          counts.minimumRefinementClearanceM = Math.min(
            counts.minimumRefinementClearanceM ?? Infinity, transitionClearance);
          for (const shorter of refinement.distances(approachMode, grid.metadata.resolution))
            if (!distances.includes(shorter)) distances.push(shorter);
        }
        const cost = this.integratedTranslationCost(state, next, state.direction === 'REVERSE',
          grid, transform, clearance, configuration);
        const preference = directionPreference(state, next, state.direction,
          configuration.weights.directionSwitchCost, state.directionPreferenceContext?.translating);
        cost.directionSwitch = preference.penaltyAmount;
        cost.total = sumCost(cost);
        if (!worthChecking(next, cost.total - cost.directionSwitch)) {
          increment(counts.primitivePruned, lengthKey); continue;
        }
        increment(counts.primitiveAttempts, lengthKey);
        counts.candidates += 1;
        emit('motionplanner.transition.candidate', { transitionType: type, from: stateKey(state),
          to: stateKey(next), primitiveDistanceM: distance, directionPreference: preference });
        if (transitionClearance + 1e-9 < configuration.clearance.hardMinimumM) {
          counts.rejected += 1;
          increment(counts.primitiveClearanceRejections, lengthKey);
          emit('motionplanner.transition.rejected', { transitionType: type,
            reason: 'HARD_MINIMUM_CLEARANCE', from: stateKey(state), to: stateKey(next),
            clearanceM: transitionClearance });
        } else if (!translation.segmentIsFreeAtHeading(grid, state, next, footprint,
          configuration.sampling.translationCollisionIntervalM, state.theta)) {
          counts.rejected += 1; counts.translationCollisions += 1;
          increment(counts.primitiveCollisions, lengthKey);
          emit('motionplanner.transition.rejected', { transitionType: type,
            primitiveDistanceM: distance, reason: 'TRANSLATION_SWEEP_COLLISION',
            from: stateKey(state), to: stateKey(next) });
          emit('collision.translation', { transitionType: type, from: stateKey(state), to: stateKey(next), bodyTheta: state.theta });
        } else {
          increment(counts.primitiveAccepted, lengthKey);
          emit('motionplanner.transition.accepted', { transitionType: type,
            from: stateKey(state), to: stateKey(next), costComponents: cost, directionPreference: preference });
          result.push({ state: next, action: { type, from: state, to: next, distanceM: distance,
            costComponents: cost, metadata: { feasibility: 'translation-sweep-passed',
              bodyTheta: state.theta, clearanceM: transitionClearance,
              directionPreference: preference,
              primitiveDistanceM: distance } } });
        }
      }
    }

    const switchedDirection: MotionDirection = state.direction === 'FORWARD' ? 'REVERSE' : 'FORWARD';
    if ((switchedDirection === 'FORWARD' && permissions.forward) ||
      (switchedDirection === 'REVERSE' && permissions.reverse)) {
      const next: SearchState = { ...state, direction: switchedDirection,
        directionPreferenceContext: preparationContext(state) };
      const cost = zeroCost();
      counts.candidates += 1;
      emit('motionplanner.transition.candidate', { transitionType: 'DIRECTION_CHANGE', from: stateKey(state), to: stateKey(next), costComponents: cost });
      result.push({ state: next, action: { type: 'DIRECTION_CHANGE', from: state,
        to: next, costComponents: cost, metadata: { feasibility: 'pose-preserved' } } });
    }
    return result;
  }

  private terminalCandidate(
    state: SearchState,
    goal: PathPoint,
    requestedTheta: number | undefined,
    permissions: Permissions,
    grid: OccupancyGrid,
    footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration,
    clearance: Float32Array,
    rotation: RotationSweepChecker,
    translation: TranslationSweepChecker,
    emit: (eventType: string, payload?: Record<string, unknown>) => void,
    counts: TransitionCounts,
    goalPositionToleranceM = 0,
  ): TerminalCandidate | undefined {
    const tolerance = requestedTheta === undefined && Number.isFinite(goalPositionToleranceM) ?
      Math.max(0, goalPositionToleranceM) : 0;
    const candidates: Array<Record<string, unknown>> = [];
    const goalBearing = Math.atan2(goal.y - state.y, goal.x - state.x);
    let best: TerminalCandidate | undefined;
    let selected: string | null = null;
    for (const direction of ['FORWARD', 'REVERSE'] as const) {
      const permitted = direction === 'FORWARD' ? permissions.forward : permissions.reverse;
      const axis = normalizeAngle(state.theta + (direction === 'REVERSE' ? Math.PI : 0));
      const ux = Math.cos(axis), uy = Math.sin(axis);
      const projectedDistance = (goal.x - state.x) * ux + (goal.y - state.y) * uy;
      const projected = { x: state.x + Math.max(0, projectedDistance) * ux,
        y: state.y + Math.max(0, projectedDistance) * uy, theta: state.theta };
      const error = Math.hypot(projected.x - goal.x, projected.y - goal.y);
      for (const strategy of ['straight', 'rotate'] as const) {
        const name = `${strategy}-${direction.toLowerCase()}`;
        const eligible = permitted && (strategy === 'rotate' ||
          (requestedTheta === undefined && projectedDistance >= 0 && error <= tolerance));
        const rejections: Array<Record<string, unknown>> = [];
        const rotationSweeps: Array<Record<string, unknown>> = [];
        const candidate = eligible ? this.exactTerminalCandidate(state,
          strategy === 'straight' ? projected : goal, requestedTheta,
          { ...permissions, forward: direction === 'FORWARD', reverse: direction === 'REVERSE',
            rotate: strategy === 'straight' ? false : permissions.rotate },
          grid, footprint, configuration, clearance, rotation, translation,
          (eventType, payload = {}) => {
            if (eventType === 'motionplanner.terminalRotation.checked') rotationSweeps.push(payload);
            else rejections.push({ eventType, ...payload });
            emit(eventType, payload);
          }, counts) : undefined;
        const requiredBodyTheta = strategy === 'straight' ? state.theta :
          normalizeAngle(goalBearing + (direction === 'REVERSE' ? Math.PI : 0));
        const alignmentRad = normalizeAngle(requiredBodyTheta - state.theta);
        const preference = directionPreference(state, goal, direction,
          configuration.weights.directionSwitchCost,
          state.directionPreferenceContext?.translating === true && direction === state.direction &&
          Math.abs(alignmentRad) <= 1e-7);
        const firstTranslation = candidate?.actions.find((action) =>
          action.type === 'TRANSLATE_FORWARD' || action.type === 'TRANSLATE_REVERSE');
        if (candidate && firstTranslation?.costComponents) {
          firstTranslation.costComponents.directionSwitch = preference.penaltyAmount;
          firstTranslation.costComponents.total = sumCost(firstTranslation.costComponents);
          firstTranslation.metadata = { ...firstTranslation.metadata, directionPreference: preference,
            directionPreferenceGoal: { x: goal.x, y: goal.y } };
          candidate.cost = candidate.actions.reduce((total, action) => total + (action.costComponents?.total ?? 0), 0);
        }
        const costComponents = candidate ? zeroCost() : null;
        if (costComponents) for (const action of candidate!.actions)
          for (const key of Object.keys(costComponents) as Array<keyof MotionCostComponents>)
            costComponents[key] += action.costComponents?.[key] ?? 0;
        candidates.push({ name, axisRad: axis, projectedTranslationDistanceM: projectedDistance,
          directionPreference: { ...preference,
            directionPreferencePenaltyApplied: Boolean(firstTranslation) && preference.directionPreferencePenaltyApplied,
            penaltyAmount: firstTranslation ? preference.penaltyAmount : 0,
            penaltyIfExecuted: preference.penaltyAmount },
          goalBearingRad: goalBearing, frontAxisRad: state.theta,
          rearAxisRad: normalizeAngle(state.theta + Math.PI), requiredBodyThetaRad: requiredBodyTheta,
          requiredMotionAxisRad: normalizeAngle(requiredBodyTheta + (direction === 'REVERSE' ? Math.PI : 0)),
          alignmentRotationRad: alignmentRad, alignmentRotationDeg: alignmentRad * 180 / Math.PI,
          rotationSweepMagnitudeRad: Math.abs(alignmentRad), rotationSweeps,
          rotationCollisionResult: rotationSweeps.some((s) => s.result === 'COLLISION') ? 'COLLISION' :
            rotationSweeps.some((s) => s.result !== 'PASSED') ? 'NOT_CHECKED' :
            rotationSweeps.length ? 'PASSED' : eligible && Math.abs(alignmentRad) <= 1e-7 ? 'NOT_REQUIRED' : 'NOT_CHECKED',
          translationDistanceM: strategy === 'straight' ? Math.max(0, projectedDistance) :
            Math.hypot(goal.x - state.x, goal.y - state.y), costComponents,
          terminalXYErrorM: strategy === 'straight' ? error : 0,
          feasible: Boolean(candidate), cost: candidate?.cost ?? null,
          reason: !permitted ? 'DIRECTION_FORBIDDEN' : !eligible ?
            requestedTheta !== undefined ? 'EXPLICIT_GOAL_HEADING' : 'OUTSIDE_GOAL_TOLERANCE_OR_BEHIND_AXIS' :
            candidate ? 'FEASIBLE' : 'PHYSICAL_CHECK_REJECTED', rejections });
        if (candidate && (!best || candidate.cost < best.cost)) {
          best = candidate; selected = name;
        }
      }
    }
    const selection = { currentHeadingRad: state.theta,
      allowedXYToleranceM: tolerance, candidates, selectedCandidate: selected,
      reason: best ? 'LOWEST_FULL_COST_FEASIBLE_CANDIDATE' : 'NO_FEASIBLE_CANDIDATE' };
    if (best) best.selection = selection;
    emit('motionplanner.terminalConnector.selection', selection);
    return best;
  }

  private exactTerminalCandidate(
    state: SearchState,
    goal: PathPoint,
    requestedTheta: number | undefined,
    permissions: Permissions,
    grid: OccupancyGrid,
    footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration,
    clearance: Float32Array,
    rotation: RotationSweepChecker,
    translation: TranslationSweepChecker,
    emit: (eventType: string, payload?: Record<string, unknown>) => void,
    counts: TransitionCounts,
  ): TerminalCandidate | undefined {
    const transform = new CoordinateTransformer(grid.metadata);
    const stateClearance = this.clearanceAt(state, transform, clearance);
    const checkedRotation = (current: MotionState, target: number, clearanceM: number,
      finalOrientation = false): boolean => {
      const result = clearanceM + 1e-9 < configuration.clearance.hardMinimumM ? 'HARD_MINIMUM_CLEARANCE' :
        !permissions.rotate ? 'ROTATION_FORBIDDEN' : rotation.rotationIsFree(grid, current,
          current.theta, target, footprint, configuration.sampling.rotationCollisionIntervalRad) ? 'PASSED' : 'COLLISION';
      emit('motionplanner.terminalRotation.checked', { fromThetaRad: current.theta,
        toThetaRad: target, sweepMagnitudeRad: angleDistance(current.theta, target),
        clearanceM, finalOrientation, result });
      return result === 'PASSED';
    };
    const distance = Math.hypot(goal.x - state.x, goal.y - state.y);
    const directions: MotionDirection[] = distance <= 1e-7 ? [state.direction] : [
      ...(permissions.forward ? ['FORWARD' as const] : []),
      ...(permissions.reverse ? ['REVERSE' as const] : []),
    ];
    let best: TerminalCandidate | undefined;
    for (const direction of directions) {
      const states: MotionState[] = [];
      const actions: MotionAction[] = [];
      let current: MotionState = { ...state };
      if (current.direction !== direction) {
        const next = { ...current, direction };
        const cost = zeroCost();
        actions.push({ type: 'DIRECTION_CHANGE', from: current, to: next, costComponents: cost,
          metadata: { feasibility: 'pose-preserved', terminalConnector: true } });
        states.push(next); current = next;
      }
      if (distance > 1e-7) {
        const bearing = Math.atan2(goal.y - current.y, goal.x - current.x);
        const bodyTheta = direction === 'FORWARD' ? bearing : normalizeAngle(bearing + Math.PI);
        if (angleDistance(current.theta, bodyTheta) > 1e-7) {
          if (!checkedRotation(current, bodyTheta, stateClearance)) {
            counts.rejected += 1; counts.rotationCollisions += 1;
            emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE', reason: permissions.rotate ? 'ROTATION_SWEEP_COLLISION' : 'ROTATION_FORBIDDEN', terminalConnector: true });
            emit('collision.rotation.sweep', { fromTheta: current.theta, toTheta: bodyTheta, terminalConnector: true });
            continue;
          }
          const next = { ...current, theta: bodyTheta, thetaBin: headingBin(bodyTheta) };
          const cost = this.rotationCost(angleDistance(current.theta, bodyTheta),
            stateClearance, configuration, grid.metadata.resolution, false);
          actions.push({ type: 'ROTATE_IN_PLACE', from: current, to: next,
            rotationRad: angleDistance(current.theta, bodyTheta), costComponents: cost,
            metadata: { feasibility: 'rotation-sweep-passed', terminalConnector: true,
              clearanceM: stateClearance } });
          states.push(next); current = next;
        }
        const goalCell = transform.worldToGrid(goal.x, goal.y);
        if (!goalCell) continue;
        const translated = { ...current, x: goal.x, y: goal.y, ...goalCell };
        const type = direction === 'FORWARD' ? 'TRANSLATE_FORWARD' : 'TRANSLATE_REVERSE';
        const transitionClearance = this.minimumSegmentClearance(current, translated,
          grid, transform, clearance, configuration.sampling.translationCollisionIntervalM);
        if (transitionClearance + 1e-9 < configuration.clearance.hardMinimumM) {
          counts.rejected += 1; counts.connectorClearanceRejections += 1;
          emit('motionplanner.transition.rejected', { transitionType: type,
            reason: 'HARD_MINIMUM_CLEARANCE', terminalConnector: true });
          continue;
        }
        if (!translation.segmentIsFreeAtHeading(grid, current, translated, footprint,
          configuration.sampling.translationCollisionIntervalM, current.theta)) {
          counts.rejected += 1; counts.translationCollisions += 1;
          counts.connectorTranslationCollisions += 1;
          emit('motionplanner.transition.rejected', { transitionType: type, reason: 'TRANSLATION_SWEEP_COLLISION', terminalConnector: true });
          emit('collision.translation', { transitionType: type, bodyTheta: current.theta, terminalConnector: true });
          continue;
        }
        const cost = this.integratedTranslationCost(current, translated, direction === 'REVERSE',
          grid, transform, clearance, configuration);
        actions.push({ type, from: current, to: translated, distanceM: distance,
          costComponents: cost, metadata: { feasibility: 'translation-sweep-passed',
            terminalConnector: true, bodyTheta: current.theta,
            clearanceM: transitionClearance } });
        states.push(translated); current = translated;
      }
      if (requestedTheta !== undefined && angleDistance(current.theta, requestedTheta) > 1e-7) {
        const finalTheta = normalizeAngle(requestedTheta);
        const finalClearance = this.clearanceAt(current, transform, clearance);
        if (!checkedRotation(current, finalTheta, finalClearance, true)) {
          counts.rejected += 1; counts.rotationCollisions += 1;
          emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE', reason: permissions.rotate ? 'FINAL_ROTATION_SWEEP_COLLISION' : 'ROTATION_FORBIDDEN', terminalConnector: true });
          emit('collision.rotation.sweep', { fromTheta: current.theta, toTheta: finalTheta, finalOrientation: true });
          continue;
        }
        const next = { ...current, theta: finalTheta, thetaBin: headingBin(finalTheta) };
        const cost = this.rotationCost(angleDistance(current.theta, finalTheta),
          finalClearance, configuration, grid.metadata.resolution, true);
        actions.push({ type: 'ROTATE_IN_PLACE', from: current, to: next,
          rotationRad: angleDistance(current.theta, finalTheta), costComponents: cost,
          metadata: { feasibility: 'rotation-sweep-passed', finalOrientation: true,
            clearanceM: finalClearance } });
        states.push(next);
      }
      const cost = actions.reduce((total, action) => total + (action.costComponents?.total ?? 0), 0);
      if (!best || cost < best.cost) best = { states, actions, cost };
    }
    return best;
  }

  private translationCost(distance: number, reverse: boolean, cellClearance: number,
    configuration: EffectiveMotionStateConfiguration): MotionCostComponents {
    const cost = zeroCost();
    cost.distance = CostModel.distance(distance,
      configuration.weights.translationCostPerM);
    cost.reverse = CostModel.motionStateReverseRisk(reverse, distance,
      configuration.weights.reverseCostPerM);
    cost.wallClearance = CostModel.motionStateWallProximity(cellClearance,
      configuration.clearance.preferredM, distance,
      configuration.weights.wallClearanceCost);
    cost.narrowPassage = CostModel.motionStateNarrowPassage(cellClearance,
      configuration.footprint.widthM, configuration.footprint.effectiveSafetyMarginM,
      configuration.passage.maximumWidthM, distance,
      configuration.weights.narrowPassageCost);
    cost.total = sumCost(cost);
    return cost;
  }

  /** Long primitives/connectors cost the same as their short-step decomposition.
   * Hard minimum still uses the entire sweep; soft costs integrate per metre.
   * Charging the worst clearance along a 4 m connector for all 4 m discouraged
   * valid connectors and made search spend its whole budget on cost refinement.
   */
  private integratedTranslationCost(from: Pick<PathPoint, 'x' | 'y'>,
    to: Pick<PathPoint, 'x' | 'y'>, reverse: boolean, grid: OccupancyGrid,
    transform: CoordinateTransformer, clearance: Float32Array,
    configuration: EffectiveMotionStateConfiguration): MotionCostComponents {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / grid.metadata.resolution - 1e-9));
    const total = zeroCost();
    for (let index = 0; index < steps; index += 1) {
      const a = { x: from.x + (to.x - from.x) * index / steps,
        y: from.y + (to.y - from.y) * index / steps };
      const b = { x: from.x + (to.x - from.x) * (index + 1) / steps,
        y: from.y + (to.y - from.y) * (index + 1) / steps };
      const minimum = this.minimumSegmentClearance(a, b, grid, transform, clearance,
        configuration.sampling.translationCollisionIntervalM);
      const components = this.translationCost(distance / steps, reverse, minimum, configuration);
      for (const key of Object.keys(total) as Array<keyof MotionCostComponents>)
        total[key] += components[key];
    }
    return total;
  }

  private rotationCost(angle: number, cellClearance: number,
    configuration: EffectiveMotionStateConfiguration, gridResolutionM: number,
    terminal: boolean): MotionCostComponents {
    const cost = zeroCost();
    if (terminal) cost.terminalOrientation = CostModel.rotation(angle,
      configuration.weights.terminalOrientationCostPerRad);
    else cost.rotation = CostModel.rotation(angle,
      configuration.weights.rotationCostPerRad);
    cost.turnLocation = CostModel.motionStateTurnLocation(angle, cellClearance,
      configuration.weights.turnLocationCost, gridResolutionM);
    cost.total = sumCost(cost);
    return cost;
  }

  private selectedDecisionEvidence(plan: MotionPlan, permissions: Permissions,
    grid: OccupancyGrid, footprint: RobotFootprint,
    configuration: EffectiveMotionStateConfiguration, clearance: Float32Array,
    rotation: RotationSweepChecker, translation: TranslationSweepChecker,
    transform: CoordinateTransformer): Array<Record<string, unknown>> {
    const important = new Set<number>([0]);
    plan.actions.forEach((action, index) => {
      const previous = plan.actions[index - 1];
      if (action.type === 'DIRECTION_CHANGE' || action.type === 'ROTATE_IN_PLACE' ||
        action.type === 'ROTATE' || previous?.type !== action.type) important.add(index);
    });
    return [...important].slice(0, 12).flatMap((actionIndex) => {
      const state = plan.states[actionIndex];
      const selected = plan.actions[actionIndex];
      if (!state || !selected || state.row === undefined || state.column === undefined ||
        state.thetaBin === undefined) return [];
      const trace: MotionPlannerDiagnosticEvent[] = [];
      const alternatives = this.transitions(state as SearchState, permissions, grid,
        footprint, configuration, clearance, rotation, translation, transform,
        (eventType, payload = {}) => trace.push({ eventType, ...payload }),
        transitionCounts(), new MotionStateRefinement(footprint, configuration, grid.metadata.resolution));
      const feasible = alternatives.map((candidate) => ({
        type: candidate.action.type, feasible: true,
        to: { x: candidate.state.x, y: candidate.state.y,
          theta: candidate.state.theta, direction: candidate.state.direction },
        clearanceM: candidate.action.metadata?.clearanceM,
        costComponents: candidate.action.costComponents,
      })).sort((left, right) =>
        (left.costComponents?.total ?? 0) - (right.costComponents?.total ?? 0));
      const rejected = trace.filter((event) =>
        event.eventType === 'motionplanner.transition.rejected').slice(0, 4).map((event) => ({
        type: event.transitionType, feasible: false, rejectionReason: event.reason,
        clearanceM: event.clearanceM,
      }));
      return [{
        actionIndex,
        at: { x: state.x, y: state.y, theta: state.theta, direction: state.direction },
        selectedTransition: { type: selected.type,
          costComponents: selected.costComponents,
          clearanceM: selected.metadata?.clearanceM },
        feasibleAlternatives: feasible.slice(0, 4),
        rejectedAlternatives: rejected,
      }];
    });
  }

  private refineState(state: SearchState, refinement: MotionStateRefinement,
    transform: CoordinateTransformer, clearance: Float32Array): void {
    state.refinementMode = refinement.mode(this.clearanceAt(state, transform, clearance));
    // Medium areas gain intermediate positions from 0.10 m translations.
    // Only tight areas need multiple representatives of the same map cell.
    state.positionKey = state.refinementMode !== 'tight' ? undefined :
      `refined:${Math.floor(state.x / refinement.positionResolutionM + 1e-9)},${Math.floor(state.y / refinement.positionResolutionM + 1e-9)}`;
  }

  private clearanceAt(point: Pick<PathPoint, 'x' | 'y'>,
    transform: CoordinateTransformer, clearance: Float32Array): number {
    const cell = transform.worldToGrid(point.x, point.y);
    return cell ? clearance[transform.index(cell)] ?? 0 : 0;
  }

  private minimumSegmentClearance(from: Pick<PathPoint, 'x' | 'y'>,
    to: Pick<PathPoint, 'x' | 'y'>, grid: OccupancyGrid,
    transform: CoordinateTransformer, clearance: Float32Array, interval: number): number {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance /
      Math.max(interval, grid.metadata.resolution / 3)));
    let minimum = Number.POSITIVE_INFINITY;
    for (let index = 0; index <= steps; index += 1) {
      const ratio = index / steps;
      minimum = Math.min(minimum, this.clearanceAt({
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
      }, transform, clearance));
    }
    return minimum;
  }

  private diagnostics(success: boolean, reason: string | undefined, code: string | undefined,
    expanded: number, passages: PlannerDiagnostics['detectedPassages']): PlannerDiagnostics {
    return {
      detectedPassages: passages, routePassageCount: passages.length,
      insertedNodeCount: 0, rejectedTurnLocations: [], relocatedTurnNodes: 0,
      minimumRouteClearanceM: 0, largestHeadingChangeDeg: 0,
      stages: [{ stage: 'motion-state-search', inputPointCount: 1,
        outputPointCount: success ? 1 : 0, success, severity: success ? 'info' : 'error',
        code: success ? 'MOTION_STATE_PLAN_FOUND' : code, reason },
      ...(success ? [{ stage: 'motionplan-optimisation' as const, inputPointCount: 1,
        outputPointCount: 1, success: true, severity: 'info' as const,
        code: 'MOTIONPLAN_OPTIMISATION_COMPLETE' },
      { stage: 'motionplan-validation' as const, inputPointCount: 1,
        outputPointCount: 1, success: true, severity: 'info' as const,
        code: 'MOTIONPLAN_VALIDATION_PASSED' }] : [])],
      warnings: passages.length ? ['PASSAGES_ANNOTATED_WITHOUT_ROUTE_REWRITE'] : [],
      finalPathSource: 'motion-state', rawPathStatus: success ? 'RAW_PATH_FOUND' : 'RAW_PATH_FAILED',
      baselineStatus: success ? 'BASELINE_PATH_VALID' : 'BASELINE_PATH_FAILED',
      doorAlignmentStatus: 'NOT_RUN', turnValidationStatus: 'NOT_RUN',
      physicalFailureCode: success ? undefined : (code as PlannerDiagnostics['physicalFailureCode']),
      recommendedOperatorAction: success ? undefined :
        'Review the footprint, motion permissions, requested final orientation, and available manoeuvre space.',
    };
  }
}
