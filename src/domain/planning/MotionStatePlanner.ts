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

/**
 * Sixteen bins provide a 22.5 degree angular resolution. This is fine enough
 * to represent useful approach orientations on the current occupancy grids,
 * while keeping the x/y/theta/direction lattice bounded. Translation is always
 * along the exact body axis; heading bins identify search states, not bearings
 * inferred from an XY path.
 */
export const MOTION_STATE_HEADING_BINS = 16;
export const MOTION_STATE_HEADING_STEP_RAD = 2 * Math.PI / MOTION_STATE_HEADING_BINS;

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
    const options = request.planningConfiguration?.planner ?? request.options;
    const sourceFootprint = request.planningConfiguration?.footprint ?? request.footprint;
    const footprint = structuredClone(sourceFootprint) as RobotFootprint;
    const configuredMargin = request.planningConfiguration
      ? request.planningConfiguration.normalized.footprint.planningSafetyMarginM +
        request.planningConfiguration.normalized.footprint.localizationMarginM
      : footprint.safetyMargin;
    footprint.safetyMargin = Math.max(footprint.safetyMargin, configuredMargin);
    const permissions: Permissions = {
      forward: request.planningConfiguration?.normalized.permissions.forwardAllowed ?? footprint.forwardAllowed ?? true,
      reverse: request.planningConfiguration?.normalized.permissions.reverseAllowed ?? footprint.backwardAllowed ?? footprint.allowReverse,
      rotate: request.planningConfiguration?.normalized.permissions.turnOnSpotAllowed ?? footprint.turnOnSpotAllowed ?? footprint.allowTurnOnSpot,
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
        (eventType === 'motionplanner.state.expanded' && payload.final === true);
      if (critical || events.length < 160) events.push({ eventType, ...payload });
    };
    emit('motionplanner.started', {
      planner: 'motion-state', headingBins: MOTION_STATE_HEADING_BINS,
      angularResolutionRad: MOTION_STATE_HEADING_STEP_RAD, angularResolutionDeg: 22.5,
      permissions,
    });

    const fail = (error: string, expanded: number, code = 'NO_PHYSICALLY_VALID_ROUTE'): PlannerResult => {
      emit('motionplanner.state.expanded', { expanded, final: true, ...eventCounts });
      emit('motionplanner.failed', { reason: error, expanded });
      const diagnostics = this.diagnostics(false, error, code, expanded, []);
      return {
        success: false, error, rawPath: [], simplifiedPath: [], finalPath: [], baselinePath: [],
        diagnostics, motionPlannerEvents: events,
        statistics: { visitedCells: expanded, durationMs: performance.now() - started,
          rawPointCount: 0, simplifiedPointCount: 0, finalPointCount: 0 },
      };
    };
    if (!permissions.forward && !permissions.reverse) return fail('Neither forward nor reverse translation is permitted.', 0, 'NO_SAFE_MANOEUVRE_SPACE');
    if (!poseChecker.pointIsFree(grid, startPose, footprint)) return fail('The complete footprint collides at the exact start pose.', 0, 'START_NOT_FREE');
    if (request.goalTheta !== undefined && !poseChecker.pointIsFree(grid,
      { ...goalPose, theta: request.goalTheta }, footprint))
      return fail('The requested final pose is not collision free.', 0, 'GOAL_NOT_FREE');

    const startCell = transform.worldToGrid(startPose.x, startPose.y);
    if (!startCell) return fail('The exact start pose is outside the occupancy grid.', 0, 'START_NOT_FREE');
    if (this.clearanceAt(startPose, transform, clearance) + 1e-9 <
      options.passageSafety.wallClearanceMinimumM)
      return fail('The exact start pose is below the configured hard minimum clearance.', 0, 'START_NOT_FREE');
    const initialDirection: MotionDirection = permissions.forward ? 'FORWARD' : 'REVERSE';
    const initial: SearchState = {
      x: startPose.x, y: startPose.y, theta: normalizeAngle(startPose.theta),
      thetaBin: headingBin(startPose.theta), direction: initialDirection,
      row: startCell.row, column: startCell.column,
    };
    const heuristic = (state: MotionState): number => CostModel.distance(
      Math.hypot(state.x - goalPose.x, state.y - goalPose.y), options.distanceWeight);
    const open = new NodeHeap();
    const first: SearchNode = { state: initial, g: 0, f: heuristic(initial) };
    open.push(first);
    const best = new Map<string, number>([[stateKey(initial), 0]]);
    let expanded = 0;
    let bestGoal: { node: SearchNode; terminal: TerminalCandidate; total: number } | undefined;
    const expansionLimit = grid.metadata.width * grid.metadata.height * MOTION_STATE_HEADING_BINS * 2;

    while (open.size && expanded < expansionLimit) {
      if (performance.now() - started > options.maxPlanningTimeMs)
        return fail('Motion-state planning timed out before finding a physically feasible plan.', expanded);
      const node = open.pop()!;
      if (node.g !== best.get(stateKey(node.state))) continue;
      if (bestGoal && node.f >= bestGoal.total - 1e-9) break;
      expanded += 1;
      if (expanded % 100 === 0) emit('motionplanner.state.expanded', { expanded, open: open.size, ...eventCounts });

      if (node.state.row === request.goal.row && node.state.column === request.goal.column) {
        const terminal = this.terminalCandidate(node.state, goalPose, request.goalTheta,
          permissions, grid, footprint, request, clearance, rotationChecker,
          translationChecker, emit, eventCounts);
        if (terminal && (!bestGoal || node.g + terminal.cost < bestGoal.total)) {
          bestGoal = { node, terminal, total: node.g + terminal.cost };
          emit('motionplanner.goal.reached', { expanded, totalCost: bestGoal.total });
        }
      }

      for (const candidate of this.transitions(node.state, permissions, grid, footprint,
        request, clearance, rotationChecker, translationChecker, transform, emit, eventCounts)) {
        const g = node.g + candidate.action.costComponents!.total;
        const key = stateKey(candidate.state);
        if (g + 1e-9 >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
        best.set(key, g);
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
    const optimisation = new MotionPlanOptimiser().optimise(
      selectedPlan, grid, footprint, options, permissions.reverse, request.goalTheta,
    );
    const plan = optimisation.plan;
    const validation = new MotionPlanValidator().validate(
      plan, grid, footprint, options.collisionSampleInterval,
      options.passageSafety.rotationCollisionSampleDeg * Math.PI / 180,
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
    });
    emit('motionplan.validation.passed', { stateCount: plan.states.length,
      actionCount: plan.actions.length, afterOptimisation: true });
    emit('motionplanner.state.expanded', { expanded, final: true, ...eventCounts });
    const selectedMetrics = measureMotionPlan(plan, grid, options.collisionSampleInterval,
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
    return {
      success: true, rawPath: path, simplifiedPath: path, baselinePath: path,
      finalPath: path, motionPlan: plan, motionPlannerEvents: events, diagnostics,
      statistics: { visitedCells: expanded, durationMs,
        rawPointCount: path.length, simplifiedPointCount: path.length, finalPointCount: path.length },
    };
  }

  private transitions(
    state: SearchState,
    permissions: Permissions,
    grid: OccupancyGrid,
    footprint: RobotFootprint,
    request: PlannerRequest,
    clearance: Float32Array,
    rotation: RotationSweepChecker,
    translation: TranslationSweepChecker,
    transform: CoordinateTransformer,
    emit: (eventType: string, payload?: Record<string, unknown>) => void,
    counts: { candidates: number; rejected: number; translationCollisions: number; rotationCollisions: number },
  ): Array<{ state: SearchState; action: MotionAction }> {
    const result: Array<{ state: SearchState; action: MotionAction }> = [];
    const options = request.planningConfiguration?.planner ?? request.options;
    const stateClearance = this.clearanceAt(state, transform, clearance);
    if (permissions.rotate) for (const delta of [-1, 1]) {
      const thetaBin = (state.thetaBin + delta + MOTION_STATE_HEADING_BINS) % MOTION_STATE_HEADING_BINS;
      const theta = binHeading(thetaBin);
      counts.candidates += 1;
      emit('motionplanner.transition.candidate', { transitionType: 'ROTATE_IN_PLACE', from: stateKey(state), thetaBin });
      if (stateClearance + 1e-9 < options.passageSafety.wallClearanceMinimumM) {
        counts.rejected += 1;
        emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE',
          reason: 'HARD_MINIMUM_CLEARANCE', from: stateKey(state), thetaBin,
          clearanceM: stateClearance });
        continue;
      }
      if (!rotation.rotationIsFree(grid, state, state.theta, theta, footprint,
        options.passageSafety.rotationCollisionSampleDeg * Math.PI / 180)) {
        counts.rejected += 1; counts.rotationCollisions += 1;
        emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE', reason: 'ROTATION_SWEEP_COLLISION', from: stateKey(state), thetaBin });
        emit('collision.rotation.sweep', { from: stateKey(state), fromTheta: state.theta, toTheta: theta });
        continue;
      }
      const next: SearchState = { ...state, theta, thetaBin };
      const cost = this.rotationCost(angleDistance(theta, state.theta), stateClearance,
        request, false);
      emit('motionplanner.transition.accepted', { transitionType: 'ROTATE_IN_PLACE',
        from: stateKey(state), to: stateKey(next), costComponents: cost });
      result.push({ state: next, action: { type: 'ROTATE_IN_PLACE', from: state, to: next,
        rotationRad: angleDistance(theta, state.theta), costComponents: cost,
        metadata: { feasibility: 'rotation-sweep-passed' } } });
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
          transform, clearance, options.collisionSampleInterval);
        if (transitionClearance + 1e-9 < options.passageSafety.wallClearanceMinimumM) {
          counts.rejected += 1;
          emit('motionplanner.transition.rejected', { transitionType: type,
            reason: 'HARD_MINIMUM_CLEARANCE', from: stateKey(state), to: stateKey(next),
            clearanceM: transitionClearance });
        } else if (!translation.segmentIsFreeAtHeading(grid, state, next, footprint,
          options.collisionSampleInterval, state.theta)) {
          counts.rejected += 1; counts.translationCollisions += 1;
          emit('motionplanner.transition.rejected', { transitionType: type, reason: 'TRANSLATION_SWEEP_COLLISION', from: stateKey(state), to: stateKey(next) });
          emit('collision.translation', { transitionType: type, from: stateKey(state), to: stateKey(next), bodyTheta: state.theta });
        } else {
          const cost = this.translationCost(distance, state.direction === 'REVERSE',
            transitionClearance, request);
          emit('motionplanner.transition.accepted', { transitionType: type,
            from: stateKey(state), to: stateKey(next), costComponents: cost });
          result.push({ state: next, action: { type, from: state, to: next, distanceM: distance,
            costComponents: cost, metadata: { feasibility: 'translation-sweep-passed', bodyTheta: state.theta } } });
        }
      }
    }

    const switchedDirection: MotionDirection = state.direction === 'FORWARD' ? 'REVERSE' : 'FORWARD';
    if ((switchedDirection === 'FORWARD' && permissions.forward) ||
      (switchedDirection === 'REVERSE' && permissions.reverse)) {
      const next: SearchState = { ...state, direction: switchedDirection };
      const cost = zeroCost();
      cost.directionSwitch = CostModel.directionSwitch(state.direction, switchedDirection, options);
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
    request: PlannerRequest,
    clearance: Float32Array,
    rotation: RotationSweepChecker,
    translation: TranslationSweepChecker,
    emit: (eventType: string, payload?: Record<string, unknown>) => void,
    counts: { candidates: number; rejected: number; translationCollisions: number; rotationCollisions: number },
  ): TerminalCandidate | undefined {
    const options = request.planningConfiguration?.planner ?? request.options;
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
        cost.directionSwitch = CostModel.directionSwitch(current.direction, direction, options);
        cost.total = sumCost(cost);
        actions.push({ type: 'DIRECTION_CHANGE', from: current, to: next, costComponents: cost,
          metadata: { feasibility: 'pose-preserved', terminalConnector: true } });
        states.push(next); current = next;
      }
      if (distance > 1e-7) {
        const bearing = Math.atan2(goal.y - current.y, goal.x - current.x);
        const bodyTheta = direction === 'FORWARD' ? bearing : normalizeAngle(bearing + Math.PI);
        if (angleDistance(current.theta, bodyTheta) > 1e-7) {
          if (stateClearance + 1e-9 < options.passageSafety.wallClearanceMinimumM ||
            !permissions.rotate || !rotation.rotationIsFree(grid, current, current.theta,
            bodyTheta, footprint, options.passageSafety.rotationCollisionSampleDeg * Math.PI / 180)) {
            counts.rejected += 1; counts.rotationCollisions += 1;
            emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE', reason: permissions.rotate ? 'ROTATION_SWEEP_COLLISION' : 'ROTATION_FORBIDDEN', terminalConnector: true });
            emit('collision.rotation.sweep', { fromTheta: current.theta, toTheta: bodyTheta, terminalConnector: true });
            continue;
          }
          const next = { ...current, theta: bodyTheta, thetaBin: headingBin(bodyTheta) };
          const cost = this.rotationCost(angleDistance(current.theta, bodyTheta),
            stateClearance, request, false);
          actions.push({ type: 'ROTATE_IN_PLACE', from: current, to: next,
            rotationRad: angleDistance(current.theta, bodyTheta), costComponents: cost,
            metadata: { feasibility: 'rotation-sweep-passed', terminalConnector: true } });
          states.push(next); current = next;
        }
        const translated = { ...current, x: goal.x, y: goal.y, row: state.row, column: state.column };
        const type = direction === 'FORWARD' ? 'TRANSLATE_FORWARD' : 'TRANSLATE_REVERSE';
        const transitionClearance = this.minimumSegmentClearance(current, translated,
          grid, transform, clearance, options.collisionSampleInterval);
        if (transitionClearance + 1e-9 < options.passageSafety.wallClearanceMinimumM ||
          !translation.segmentIsFreeAtHeading(grid, current, translated, footprint,
          options.collisionSampleInterval, current.theta)) {
          counts.rejected += 1; counts.translationCollisions += 1;
          emit('motionplanner.transition.rejected', { transitionType: type, reason: 'TRANSLATION_SWEEP_COLLISION', terminalConnector: true });
          emit('collision.translation', { transitionType: type, bodyTheta: current.theta, terminalConnector: true });
          continue;
        }
        const cost = this.translationCost(distance, direction === 'REVERSE',
          transitionClearance, request);
        actions.push({ type, from: current, to: translated, distanceM: distance,
          costComponents: cost, metadata: { feasibility: 'translation-sweep-passed', terminalConnector: true, bodyTheta: current.theta } });
        states.push(translated); current = translated;
      }
      if (requestedTheta !== undefined && angleDistance(current.theta, requestedTheta) > 1e-7) {
        const finalTheta = normalizeAngle(requestedTheta);
        const finalClearance = this.clearanceAt(current, transform, clearance);
        if (finalClearance + 1e-9 < options.passageSafety.wallClearanceMinimumM ||
          !permissions.rotate || !rotation.rotationIsFree(grid, current, current.theta,
          finalTheta, footprint, options.passageSafety.rotationCollisionSampleDeg * Math.PI / 180)) {
          counts.rejected += 1; counts.rotationCollisions += 1;
          emit('motionplanner.transition.rejected', { transitionType: 'ROTATE_IN_PLACE', reason: permissions.rotate ? 'FINAL_ROTATION_SWEEP_COLLISION' : 'ROTATION_FORBIDDEN', terminalConnector: true });
          emit('collision.rotation.sweep', { fromTheta: current.theta, toTheta: finalTheta, finalOrientation: true });
          continue;
        }
        const next = { ...current, theta: finalTheta, thetaBin: headingBin(finalTheta) };
        const cost = this.rotationCost(angleDistance(current.theta, finalTheta),
          finalClearance, request, true);
        actions.push({ type: 'ROTATE_IN_PLACE', from: current, to: next,
          rotationRad: angleDistance(current.theta, finalTheta), costComponents: cost,
          metadata: { feasibility: 'rotation-sweep-passed', finalOrientation: true } });
        states.push(next);
      }
      const cost = actions.reduce((total, action) => total + (action.costComponents?.total ?? 0), 0);
      if (!best || cost < best.cost) best = { states, actions, cost };
    }
    return best;
  }

  private translationCost(distance: number, reverse: boolean, cellClearance: number,
    request: PlannerRequest): MotionCostComponents {
    const options = request.planningConfiguration?.planner ?? request.options;
    const footprint = request.planningConfiguration?.footprint ?? request.footprint;
    const cost = zeroCost();
    cost.distance = CostModel.distance(distance, options.distanceWeight);
    cost.reverse = CostModel.reverseRisk(reverse, options);
    cost.wallClearance = CostModel.wallProximity(cellClearance, options);
    cost.narrowPassage = CostModel.narrowPassage(cellClearance, footprint.width,
      footprint.safetyMargin, options);
    cost.total = sumCost(cost);
    return cost;
  }

  private rotationCost(angle: number, cellClearance: number, request: PlannerRequest,
    terminal: boolean): MotionCostComponents {
    const options = request.planningConfiguration?.planner ?? request.options;
    const cost = zeroCost();
    if (terminal) cost.terminalOrientation = CostModel.rotation(angle, options.passageSafety.headingChangeWeight);
    else cost.rotation = CostModel.rotation(angle, options.passageSafety.headingChangeWeight);
    cost.turnLocation = CostModel.turnLocation(angle, cellClearance, options,
      request.grid.metadata.resolution);
    cost.total = sumCost(cost);
    return cost;
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
