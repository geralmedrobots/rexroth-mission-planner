import { CoordinateTransformer } from '../../domain/geometry/CoordinateTransformer';
import { createMotionPlannerScenarioArtifact, type MotionPlannerScenarioArtifact } from '../../domain/planning/MotionPlannerScenarioArtifact';
import { PlannerService, type PlannerRequest } from '../../domain/planner/PlannerService';
import { createPlanningConfigurationSnapshot, type PlanningConfigurationSnapshot } from '../../domain/planning/PlanningConfigurationSnapshot';
import type { DiagnosticSink } from '../diagnostics/DiagnosticEvent';
import { planningRequestId, createDiagnosticEvent } from '../diagnostics/DiagnosticEvent';
import type { OccupancyGrid, PathPoint, PlannerMode, PlannerResult, PlannerOptions, RobotFootprint, RobotPose, Waypoint, OrderSettings } from '../../domain/types';

export interface PlanningInputs {
  readonly grid: OccupancyGrid;
  readonly start: RobotPose;
  readonly goal: RobotPose;
  readonly waypoints: readonly Waypoint[];
  readonly plannerMode: PlannerMode;
  readonly plannerOptions: PlannerOptions;
  readonly footprint: RobotFootprint;
  readonly orderSettings?: OrderSettings;
  readonly goalThetaExplicit?: boolean;
  readonly sessionId: string;
  readonly missionId?: string;
  readonly routeRevision?: number;
}

export interface PlanningCoordinatorDependencies {
  readonly onRecordingStart?: (inputs: PlanningInputs, configuration: PlanningConfigurationSnapshot) => {
    result: (result: PlannerResult) => void;
    stop: (reason: string) => void;
  };
  readonly planner?: Pick<PlannerService, 'plan'>;
  readonly diagnostics?: DiagnosticSink;
  readonly onScenarioCaptured?: (artifact: MotionPlannerScenarioArtifact) => void;
}

export interface PreparedPlanningRequest extends PlannerRequest { readonly planningConfiguration: PlanningConfigurationSnapshot }
export type CoordinatedPlanningResult = PlannerResult & {
  readonly planningConfiguration: PlanningConfigurationSnapshot;
  readonly routeRevision?: number;
};

/** Application-level planning orchestration. Domain planners remain unchanged. */
export class PlanningCoordinator {
  private sequence = 0;
  private generation = 0;
  public constructor(private readonly dependencies: PlanningCoordinatorDependencies = {}) {}

  public createSnapshot(inputs: Pick<PlanningInputs, 'plannerOptions' | 'footprint' | 'orderSettings'>): PlanningConfigurationSnapshot {
    return createPlanningConfigurationSnapshot({
      plannerOptions: inputs.plannerOptions,
      footprint: inputs.footprint,
      orderSettings: inputs.orderSettings,
    });
  }

  public prepareRequests(inputs: PlanningInputs): readonly PreparedPlanningRequest[] {
    const configuration = this.createSnapshot(inputs);
    const requestId = planningRequestId(inputs.sessionId, ++this.sequence);
    const anchors: readonly RobotPose[] = inputs.plannerMode === 'hybrid'
      ? [inputs.start, ...inputs.waypoints.map((waypoint) => ({ ...waypoint, mapId: inputs.grid.metadata.mapId, positionInitialized: true })), inputs.goal]
      : [inputs.start, inputs.goal];
    const transform = new CoordinateTransformer(inputs.grid.metadata);
    return anchors.slice(0, -1).map((anchor, index) => {
      const next = anchors[index + 1]!;
      const start = transform.worldToGrid(anchor.x, anchor.y);
      const goal = transform.worldToGrid(next.x, next.y);
      if (!start || !goal) throw new Error(`Anchor ${index} is outside the map.`);
      return {
        grid: inputs.grid, collisionGrid: inputs.grid, start, goal,
        options: structuredClone(configuration.planner) as PlannerOptions,
        footprint: structuredClone(configuration.footprint) as RobotFootprint,
        startTheta: anchor.theta, exactStartPose: anchor, exactGoalPose: next,
        goalTheta: index === anchors.length - 2 && !inputs.goalThetaExplicit ? undefined : next.theta,
        planningConfiguration: configuration,
        plannerStrategy: inputs.plannerMode === 'motion-state' ? 'motion-state' : 'legacy',
        diagnosticContext: { sessionId: inputs.sessionId, missionId: inputs.missionId, planningRequestId: requestId },
      };
    });
  }

  public invalidate(): void { this.generation += 1; }

  public async plan(inputs: PlanningInputs): Promise<CoordinatedPlanningResult | undefined> {
    // Capture every input once. The worker may outlive the React render that
    // initiated this operation, so no mutable store object may be consulted
    // after this point.
    const captured = structuredClone(inputs);
    const generation = ++this.generation;
    const requests = this.prepareRequests(captured);
    let recording: ReturnType<NonNullable<PlanningCoordinatorDependencies['onRecordingStart']>> | undefined;
    try {
      if (captured.plannerMode === 'motion-state') recording = this.dependencies.onRecordingStart?.(captured, requests[0]!.planningConfiguration);
    } catch { /* Recording must never affect planning. The recording adapter reports failures. */ }
    const planner = this.dependencies.planner ?? new PlannerService();
    let combined: CoordinatedPlanningResult | undefined;
    const raw: PathPoint[] = []; const simplified: PathPoint[] = []; const final: PathPoint[] = [];
    const baseline: PathPoint[] = []; const rejectedEnhancement: PathPoint[] = [];
    let visitedCells = 0; let durationMs = 0;
    let diagnostics: PlannerResult['diagnostics'];
    for (const [index, request] of requests.entries()) {
      let result: PlannerResult;
      try { result = await planner.plan(request); }
      catch (error) { try { recording?.stop(`Planning exception: ${String(error)}`); } catch { /* Observer isolation. */ } throw error; }
      try { recording?.result(result); } catch { /* Observer isolation. */ }
      if (generation !== this.generation) {
        try { recording?.stop('Planning request superseded or invalidated'); } catch { /* Observer isolation. */ }
        return undefined;
      }
      if (captured.plannerMode === 'motion-state') {
        try {
        this.dependencies.onScenarioCaptured?.(createMotionPlannerScenarioArtifact({
          grid: captured.grid, footprint: captured.footprint,
          startPose: captured.start, goalPose: captured.goal, goalTheta: request.goalTheta,
          configuration: request.planningConfiguration, originalCalibration: result.motionPlannerCalibration,
          capture: { plannerMode: captured.plannerMode, waypoints: captured.waypoints,
            waypointsUsed: false, capturedAt: new Date().toISOString(), result },
        }));
        } catch (error) {
          this.dependencies.diagnostics?.emit(createDiagnosticEvent({
            sessionId: captured.sessionId, stage: 'motionplan', severity: 'warning',
            eventType: 'motionplanner.scenario.export.failed',
            message: `Scenario capture failed: ${String(error)}`,
          }));
        }
      }
      // Worker-produced diagnostics cross the worker boundary as part of the
      // PlannerResult and are forwarded through the application sink here.
      result.diagnosticEvents?.forEach((event) => this.dependencies.diagnostics?.emit(event));
      raw.push(...result.rawPath.slice(index ? 1 : 0));
      simplified.push(...result.simplifiedPath.slice(index ? 1 : 0));
      baseline.push(...(result.baselinePath ?? []).slice(index ? 1 : 0));
      rejectedEnhancement.push(...(result.rejectedEnhancementPath ?? []).slice(index ? 1 : 0));
      final.push(...result.finalPath.slice(index ? 1 : 0));
      visitedCells += result.statistics.visitedCells; durationMs += result.statistics.durationMs;
      if (result.diagnostics) {
        if (!diagnostics) diagnostics = structuredClone(result.diagnostics);
        else {
          diagnostics.detectedPassages.push(...result.diagnostics.detectedPassages);
          diagnostics.rejectedTurnLocations.push(...result.diagnostics.rejectedTurnLocations);
          diagnostics.stages.push(...result.diagnostics.stages);
          diagnostics.warnings.push(...result.diagnostics.warnings);
          diagnostics.routePassageCount += result.diagnostics.routePassageCount;
          diagnostics.insertedNodeCount += result.diagnostics.insertedNodeCount;
          diagnostics.relocatedTurnNodes += result.diagnostics.relocatedTurnNodes;
          diagnostics.minimumRouteClearanceM = Math.min(diagnostics.minimumRouteClearanceM, result.diagnostics.minimumRouteClearanceM);
          diagnostics.largestHeadingChangeDeg = Math.max(diagnostics.largestHeadingChangeDeg, result.diagnostics.largestHeadingChangeDeg);
        }
      }
      if (!result.success) return { ...result, diagnostics, rawPath: raw, simplifiedPath: simplified, baselinePath: baseline, rejectedEnhancementPath: rejectedEnhancement, finalPath: baseline.length ? baseline : final, planningConfiguration: requests[0]!.planningConfiguration, routeRevision:captured.routeRevision };
      combined = { ...result, rawPath: raw, simplifiedPath: simplified, finalPath: final,
        baselinePath: baseline, rejectedEnhancementPath: rejectedEnhancement,
        diagnostics,
        statistics: { ...result.statistics, visitedCells, durationMs, rawPointCount: raw.length, simplifiedPointCount: simplified.length, finalPointCount: final.length }, planningConfiguration: requests[0]!.planningConfiguration,
        routeRevision:captured.routeRevision };
    }
    if (!combined) return undefined;
    this.dependencies.diagnostics?.emit(createDiagnosticEvent({
      sessionId: captured.sessionId, missionId: captured.missionId, planningRequestId: requests[0]?.diagnosticContext?.planningRequestId,
      stage: 'motionplan', severity: 'info', eventType: 'motionplan.created', message: 'Motion plan created.',
      payload: { pointCount: final.length },
    }));
    return combined;
  }
}
