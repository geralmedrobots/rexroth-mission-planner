import { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import { normalizeAngle } from '../geometry/angles';
import type {
  MotionAction, MotionCostComponents, MotionDirection, MotionPlan, MotionState,
} from '../motion/planningModel';
import { measureMotionPlan } from '../motion/MotionPlanMetrics';
import type { PlannerRequest } from '../planner/PlannerService';
import { buildMotionStateClearanceField } from '../planner/ClearanceField';
import { MotionPlanValidator } from '../planner/MotionPlanValidator';
import { PassageDetector } from '../planner/PassageDetector';
import { PoseCollisionChecker } from '../planner/PoseCollisionChecker';
import { RotationSweepChecker } from '../planner/RotationSweepChecker';
import { TranslationSweepChecker } from '../planner/TranslationSweepChecker';
import type {
  OccupancyGrid, PathPoint, PlannerDiagnostics, PlannerResult, RobotFootprint,
} from '../types';
import { CostModel } from './CostModel';
import { MotionPlanOptimiser } from './MotionPlanOptimiser';
import { createPlanningConfigurationSnapshot } from './PlanningConfigurationSnapshot';
import {
  MOTION_STATE_HEADING_BINS, MOTION_STATE_HEADING_STEP_RAD,
  type EffectiveMotionStateConfiguration,
} from './MotionStateConfiguration';
import { createMotionPlannerCalibrationSnapshot } from './MotionPlannerCalibration';

export { MOTION_STATE_HEADING_BINS, MOTION_STATE_HEADING_STEP_RAD } from './MotionStateConfiguration';

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
}

interface SearchNode {
  state: SearchState;
  g: number;
  f: number;
  parent?: SearchNode;
  action?: MotionAction;
}

interface TerminalCandidate {
  states: MotionState[];
  actions: MotionAction[];
  cost: number;
}

interface Permissions {
  forward: boolean;
  reverse: boolean;
  rotate: boolean;
}

class NodeHeap {
  private readonly values: SearchNode[] = [];
  public push(value: SearchNode): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.f <= value.f) break;
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
      const child = right < this.values.length && this.values[right]!.f < this.values[left]!.f ? right : left;
      if (this.values[child]!.f >= tail.f) break;
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
  `${state.row},${state.column},${state.thetaBin},${state.direction}`;
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
    const poseChecker = new PoseCollisionChecker();
    const rotationChecker = new RotationSweepChecker(poseChecker);
    const translationChecker = new TranslationSweepChecker(poseChecker);
    const clearance = buildMotionStateClearanceField(grid);
    const events: MotionPlannerDiagnosticEvent[] = [];
    const eventCounts = { candidates: 0, rejected: 0, translationCollisions: 0, rotationCollisions: 0 };
    const emit = (eventType: string, payload: Record<string, unknown> = {}): void => {
      const critical = eventType === 'motionplanner.started' ||
        eventType === 'motionplanner.goal.reached' || eventType === 'motionplanner.failed' ||
        eventType === 'motionplan.created' || eventType === 'motionplan.optimised' ||
        eventType === 'motionplan.selected.summary' || eventType.startsWith('motionplan.validation.') ||
        eventType === 'motionplanner.calibration.snapshot' ||
        (eventType === 'motionplanner.state.expanded' && payload.final === true);
      if (critical || events.length < 160) events.push({ eventType, ...payload });
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
      return result;
    };
    const fail = (error: string, expanded: number, code = 'NO_PHYSICALLY_VALID_ROUTE'): PlannerResult => {
      emit('motionplanner.state.expanded', { expanded, final: true, ...eventCounts });
      emit('motionplanner.failed', { reason: error, expanded });
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
    if (this.clearanceAt(startPose, transform, clearance) + 1e-9 <
      motionConfiguration.clearance.hardMinimumM)
      return fail('The exact start pose is below the configured hard minimum clearance.', 0, 'START_NOT_FREE');
    const initialDirection: MotionDirection = permissions.forward ? 'FORWARD' : 'REVERSE';
    const initial: SearchState = {
      x: startPose.x, y: startPose.y, theta: normalizeAngle(startPose.theta),
      thetaBin: headingBin(startPose.theta), direction: initialDirection,
      row: startCell.row, column: startCell.column,
    };
    const heuristic = (state: MotionState): number => CostModel.distance(
      Math.hypot(state.x - goalPose.x, state.y - goalPose.y),
      motionConfiguration.weights.translationCostPerM);
    const open = new NodeHeap();
    const first: SearchNode = { state: initial, g: 0, f: heuristic(initial) };
    open.push(first);
    const best = new Map<string, number>([[stateKey(initial), 0]]);
    let expanded = 0;
    let bestGoal: { node: SearchNode; terminal: TerminalCandidate; total: number } | undefined;
    const exploredClearanceCandidates: Array<{
      clearanceM: number; accumulatedCost: number; actionType: string;
      x: number; y: number; direction: MotionDirection;
    }> = [];
    const expansionLimit = grid.metadata.width * grid.metadata.height * MOTION_STATE_HEADING_BINS * 2;

    while (open.size && expanded < expansionLimit) {
      if (performance.now() - started > motionConfiguration.maximumPlanningTimeMs)
        return fail('Motion-state planning timed out before finding a physically feasible plan.', expanded);
      const node = open.pop()!;
      if (node.g !== best.get(stateKey(node.state))) continue;
      if (bestGoal && node.f >= bestGoal.total - 1e-9) break;
      expanded += 1;
      if (expanded % 100 === 0) emit('motionplanner.state.expanded', { expanded, open: open.size, ...eventCounts });

      if (node.state.row === request.goal.row && node.state.column === request.goal.column) {
        const terminal = this.terminalCandidate(node.state, goalPose, request.goalTheta,
          permissions, grid, footprint, motionConfiguration, clearance, rotationChecker,
          translationChecker, emit, eventCounts);
        if (terminal && (!bestGoal || node.g + terminal.cost < bestGoal.total)) {
          bestGoal = { node, terminal, total: node.g + terminal.cost };
          emit('motionplanner.goal.reached', { expanded, totalCost: bestGoal.total });
        }
      }

      for (const candidate of this.transitions(node.state, permissions, grid, footprint,
        motionConfiguration, clearance, rotationChecker, translationChecker, transform,
        emit, eventCounts)) {
        const g = node.g + candidate.action.costComponents!.total;
        const key = stateKey(candidate.state);
        if (g + 1e-9 >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
        best.set(key, g);
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
        open.push({ state: candidate.state, action: candidate.action, parent: node,
          g, f: g + heuristic(candidate.state) });
      }
    }
    if (!bestGoal) return fail('No physically feasible MotionPlan exists for the requested pose.', expanded);

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
    const totalCost = actions.reduce((total, action) => total + (action.costComponents?.total ?? 0), 0);
    const selectedPlan: MotionPlan = {
      states, actions,
      metadata: {
        source: 'motion-state-planner', plannerVersion: 'stage-5', cost: totalCost,
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
    const durationMs = performance.now() - started;
    const selectedDiagnostic = {
      plannerMode: 'motion-state', planningDurationMs: durationMs, expandedStates: expanded,
      selectedTotalCost: totalCost,
      translationCost: selectedMetrics.costs.distance,
      rotationCost: selectedMetrics.costs.rotation,
      reverseCost: selectedMetrics.costs.reverse,
      directionSwitchCost: selectedMetrics.costs.directionSwitch,
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
      actionCount: plan.actions.length, totalCost });
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
    counts: { candidates: number; rejected: number; translationCollisions: number; rotationCollisions: number },
  ): Array<{ state: SearchState; action: MotionAction }> {
    const result: Array<{ state: SearchState; action: MotionAction }> = [];
    const stateClearance = this.clearanceAt(state, transform, clearance);
    if (permissions.rotate) for (const delta of [-1, 1]) {
      const thetaBin = (state.thetaBin + delta + MOTION_STATE_HEADING_BINS) % MOTION_STATE_HEADING_BINS;
      const theta = binHeading(thetaBin);
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
      const next: SearchState = { ...state, theta, thetaBin };
      const cost = this.rotationCost(angleDistance(theta, state.theta), stateClearance,
        configuration, grid.metadata.resolution, false);
      emit('motionplanner.transition.accepted', { transitionType: 'ROTATE_IN_PLACE',
        from: stateKey(state), to: stateKey(next), costComponents: cost });
      result.push({ state: next, action: { type: 'ROTATE_IN_PLACE', from: state, to: next,
        rotationRad: angleDistance(theta, state.theta), costComponents: cost,
        metadata: { feasibility: 'rotation-sweep-passed', clearanceM: stateClearance } } });
    }

    const translationPermitted = state.direction === 'FORWARD' ? permissions.forward : permissions.reverse;
    if (translationPermitted) {
      const sign = state.direction === 'FORWARD' ? 1 : -1;
      const distance = grid.metadata.resolution;
      const target = { x: state.x + sign * Math.cos(state.theta) * distance,
        y: state.y + sign * Math.sin(state.theta) * distance };
      const cell = transform.worldToGrid(target.x, target.y);
      if (cell && (cell.row !== state.row || cell.column !== state.column)) {
        const next: SearchState = { ...target, theta: state.theta, thetaBin: state.thetaBin,
          direction: state.direction, row: cell.row, column: cell.column };
        const type = state.direction === 'FORWARD' ? 'TRANSLATE_FORWARD' : 'TRANSLATE_REVERSE';
        counts.candidates += 1;
        emit('motionplanner.transition.candidate', { transitionType: type, from: stateKey(state), to: stateKey(next) });
        const transitionClearance = this.minimumSegmentClearance(state, next, grid,
          transform, clearance, configuration.sampling.translationCollisionIntervalM);
        if (transitionClearance + 1e-9 < configuration.clearance.hardMinimumM) {
          counts.rejected += 1;
          emit('motionplanner.transition.rejected', { transitionType: type,
            reason: 'HARD_MINIMUM_CLEARANCE', from: stateKey(state), to: stateKey(next),
            clearanceM: transitionClearance });
        } else if (!translation.segmentIsFreeAtHeading(grid, state, next, footprint,
          configuration.sampling.translationCollisionIntervalM, state.theta)) {
          counts.rejected += 1; counts.translationCollisions += 1;
          emit('motionplanner.transition.rejected', { transitionType: type, reason: 'TRANSLATION_SWEEP_COLLISION', from: stateKey(state), to: stateKey(next) });
          emit('collision.translation', { transitionType: type, from: stateKey(state), to: stateKey(next), bodyTheta: state.theta });
        } else {
          const cost = this.translationCost(distance, state.direction === 'REVERSE',
            transitionClearance, configuration);
          emit('motionplanner.transition.accepted', { transitionType: type,
            from: stateKey(state), to: stateKey(next), costComponents: cost });
          result.push({ state: next, action: { type, from: state, to: next, distanceM: distance,
            costComponents: cost, metadata: { feasibility: 'translation-sweep-passed',
              bodyTheta: state.theta, clearanceM: transitionClearance } } });
        }
      }
    }

    const switchedDirection: MotionDirection = state.direction === 'FORWARD' ? 'REVERSE' : 'FORWARD';
    if ((switchedDirection === 'FORWARD' && permissions.forward) ||
      (switchedDirection === 'REVERSE' && permissions.reverse)) {
      const next: SearchState = { ...state, direction: switchedDirection };
      const cost = zeroCost();
      cost.directionSwitch = CostModel.motionStateDirectionSwitch(state.direction,
        switchedDirection, configuration.weights.directionSwitchCost);
      cost.total = sumCost(cost);
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
    counts: { candidates: number; rejected: number; translationCollisions: number; rotationCollisions: number },
  ): TerminalCandidate | undefined {
    const transform = new CoordinateTransformer(grid.metadata);
    const stateClearance = this.clearanceAt(state, transform, clearance);
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
        cost.directionSwitch = CostModel.motionStateDirectionSwitch(current.direction,
          direction, configuration.weights.directionSwitchCost);
        cost.total = sumCost(cost);
        actions.push({ type: 'DIRECTION_CHANGE', from: current, to: next, costComponents: cost,
          metadata: { feasibility: 'pose-preserved', terminalConnector: true } });
        states.push(next); current = next;
      }
      if (distance > 1e-7) {
        const bearing = Math.atan2(goal.y - current.y, goal.x - current.x);
        const bodyTheta = direction === 'FORWARD' ? bearing : normalizeAngle(bearing + Math.PI);
        if (angleDistance(current.theta, bodyTheta) > 1e-7) {
          if (stateClearance + 1e-9 < configuration.clearance.hardMinimumM ||
            !permissions.rotate || !rotation.rotationIsFree(grid, current, current.theta,
            bodyTheta, footprint, configuration.sampling.rotationCollisionIntervalRad)) {
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
        const translated = { ...current, x: goal.x, y: goal.y, row: state.row, column: state.column };
        const type = direction === 'FORWARD' ? 'TRANSLATE_FORWARD' : 'TRANSLATE_REVERSE';
        const transitionClearance = this.minimumSegmentClearance(current, translated,
          grid, transform, clearance, configuration.sampling.translationCollisionIntervalM);
        if (transitionClearance + 1e-9 < configuration.clearance.hardMinimumM ||
          !translation.segmentIsFreeAtHeading(grid, current, translated, footprint,
          configuration.sampling.translationCollisionIntervalM, current.theta)) {
          counts.rejected += 1; counts.translationCollisions += 1;
          emit('motionplanner.transition.rejected', { transitionType: type, reason: 'TRANSLATION_SWEEP_COLLISION', terminalConnector: true });
          emit('collision.translation', { transitionType: type, bodyTheta: current.theta, terminalConnector: true });
          continue;
        }
        const cost = this.translationCost(distance, direction === 'REVERSE',
          transitionClearance, configuration);
        actions.push({ type, from: current, to: translated, distanceM: distance,
          costComponents: cost, metadata: { feasibility: 'translation-sweep-passed',
            terminalConnector: true, bodyTheta: current.theta,
            clearanceM: transitionClearance } });
        states.push(translated); current = translated;
      }
      if (requestedTheta !== undefined && angleDistance(current.theta, requestedTheta) > 1e-7) {
        const finalTheta = normalizeAngle(requestedTheta);
        const finalClearance = this.clearanceAt(current, transform, clearance);
        if (finalClearance + 1e-9 < configuration.clearance.hardMinimumM ||
          !permissions.rotate || !rotation.rotationIsFree(grid, current, current.theta,
          finalTheta, footprint, configuration.sampling.rotationCollisionIntervalRad)) {
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
    cost.reverse = CostModel.motionStateReverseRisk(reverse,
      configuration.weights.reverseCostPerTranslation);
    cost.wallClearance = CostModel.motionStateWallProximity(cellClearance,
      configuration.clearance.preferredM, configuration.weights.wallClearanceCost);
    cost.narrowPassage = CostModel.motionStateNarrowPassage(cellClearance,
      configuration.footprint.widthM, configuration.footprint.effectiveSafetyMarginM,
      configuration.passage.maximumWidthM, configuration.weights.narrowPassageCost);
    cost.total = sumCost(cost);
    return cost;
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
        { candidates: 0, rejected: 0, translationCollisions: 0, rotationCollisions: 0 });
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
