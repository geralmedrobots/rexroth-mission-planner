import { z } from 'zod';
import { names, type BoundPoint } from '../src/features/pharmacy/model';
import { CoordinateTransformer } from '../src/domain/geometry/CoordinateTransformer';
import { PathCollisionValidator } from '../src/domain/planner/PathCollisionValidator';
import { ObstacleInflation } from '../src/domain/planner/ObstacleInflation';
import { planSynchronously } from '../src/domain/planner/PlannerService';
import { createPlanningConfigurationSnapshot } from '../src/domain/planning/PlanningConfigurationSnapshot';
import { VdaOrderBuilder } from '../src/domain/vda5050/VdaOrderBuilder';
import { VdaOrderValidator } from '../src/domain/vda5050/VdaOrderValidator';
import { getOrderGenerationIssues } from '../src/domain/vda5050/OrderGenerationGuard';
import { getActiveNavigatorOrderId, getDispatchIssues } from '../src/features/mission/dispatchGate';
import { validateDestination } from '../src/features/mission/destinationValidation';
import type {
  OccupancyGrid,
  OrderSettings,
  PlannerOptions,
  RobotFootprint,
  VdaState,
  VdaOrder,
  PlannerMode,
} from '../src/domain/types';

export const mapSchema = z
  .object({
    metadata: z.object({
      name: z.string(),
      mapId: z.string().trim().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      origin: z.object({ x: z.number(), y: z.number(), yaw: z.number() }),
      resolution: z.number().positive(),
      occupiedThreshold: z.number().positive().max(100),
      freeThreshold: z.number().nonnegative(),
      negate: z.boolean(),
    }),
    data: z.array(z.number().min(-1).max(100)),
  })
  .refine(
    (g) => g.data.length === g.metadata.width * g.metadata.height,
    'Invalid raster dimensions.',
  );
export const pointSchema = z.object({
  id: z.string().min(1),
  mapId: z.string().min(1),
  displayName: z.string(),
  x: z.number(),
  y: z.number(),
  theta: z.number(),
  enabled: z.boolean(),
  thetaExplicit: z.boolean().optional(),
});
export interface Config {
  minQuality?: number;
  points: Record<string, BoundPoint>;
  maps: Record<string, OccupancyGrid>;
  orderSettings: OrderSettings;
  plannerOptions: PlannerOptions;
  footprint: RobotFootprint;
  plannerMode: PlannerMode;
  nodeLimit: number;
}
export function bindLocations(input: unknown, config: Omit<Config, 'points'>): Config {
  const items = z.array(pointSchema).parse(input);
  const points = {} as Config['points'];
  for (const name of names) {
    const found = items.filter((p) => p.displayName === name);
    if (found.length !== 1 || !found[0]!.enabled || found[0]!.thetaExplicit === false)
      throw Error(`Configure one enabled waypoint with a heading: ${name}.`);
    const p = found[0]!,
      grid = config.maps[p.mapId];
    if (!grid || grid.metadata.mapId !== p.mapId)
      throw Error(`Register the Locator map for ${name}.`);
    const pose = { ...p, positionInitialized: true };
    if (
      !validateDestination(pose, p.mapId, grid).valid ||
      !new PathCollisionValidator().pointIsFree(grid, pose, config.footprint)
    )
      throw Error(`Invalid waypoint position: ${name}.`);
    points[name] = p;
  }
  if (new Set(Object.values(points).map((p) => p.id)).size !== names.length)
    throw Error('Waypoint identifiers must be distinct.');
  const pharmacy = points[names[0]].mapId,
    urgencies = points[names[4]].mapId;
  if (
    pharmacy === urgencies ||
    names.some((n, i) => points[n].mapId !== (i < 4 ? pharmacy : urgencies))
  )
    throw Error('Assign pharmacy and urgencies waypoints to their two distinct floor maps.');
  return { ...config, points };
}
export interface Frame {
  state: VdaState;
  received: number;
  source: number;
}
export function validateOrder(c: Config, f: Frame, order: VdaOrder, now: number) {
  const s = f.state,
    pose = s.agvPosition!,
    grid = c.maps[pose.mapId]!;
  const age = Math.max(now - f.source, now - f.received),
    map = grid.metadata.mapId;
  const issues = getOrderGenerationIssues({
    mqttConnected: true,
    connectionOnline: true,
    operatingMode: s.operatingMode,
    stateAgeMs: age,
    maximumStateAgeMs: c.orderSettings.stateStaleTimeoutMs,
    lastStateReceiveTime: f.received,
    positionInitialized: pose.positionInitialized,
    pose: { pose, source: 'state', receivedAtMs: f.received, mapIdSource: 'state' },
    activeMapId: pose.mapId,
    activeMapSource: 'state',
    loadedLocatorMapName: map,
  });
  const result = new VdaOrderValidator().validate(order, {
    mqttConnected: true,
    connectionOnline: true,
    connectionReceived: true,
    stateReceived: true,
    operatingMode: s.operatingMode,
    stateAgeMs: age,
    visualizationAgeMs: Infinity,
    positionInitialized: pose.positionInitialized,
    poseSource: 'state',
    activeMapId: pose.mapId,
    currentPose: pose,
    grid,
    footprint: c.footprint,
    settings: c.orderSettings,
    locatorMapName: map,
    mapIdSource: 'state',
    lastStateReceiveTime: f.received,
    corridorSettings: c.plannerOptions.corridor,
  });
  const blockers = [
    ...issues.filter((i) => i.severity === 'error'),
    ...result.errors,
    ...getDispatchIssues({
      mqttConnected: true,
      robotOnline: true,
      stateFresh: age <= c.orderSettings.stateStaleTimeoutMs,
      poseValid: pose.positionInitialized,
      mapMatches: pose.mapId === map,
      validation: result,
      state: s,
      hasActiveDifferentOrder: !!getActiveNavigatorOrderId(s),
    }),
  ];
  if (order.nodes.length > c.nodeLimit || blockers.length)
    throw Error(blockers[0]?.message ?? 'Configured VDA node limit exceeded.');
}
export function planLeg(c: Config, f: Frame, target: BoundPoint, now: number) {
  const start = f.state.agvPosition!;
  if (start.mapId !== target.mapId) throw Error('Cross-floor routes are prohibited.');
  const grid = c.maps[target.mapId]!,
    goal = { ...target, positionInitialized: true },
    snapshot = createPlanningConfigurationSnapshot(c);
  const inflated = ObstacleInflation.byRadius(
    grid,
    c.plannerOptions.passageSafety.planningSafetyMarginM +
      c.plannerOptions.passageSafety.localizationMarginM,
  );
  const dest = validateDestination(goal, start.mapId, grid, inflated);
  const from = new CoordinateTransformer(grid.metadata).worldToGrid(start.x, start.y);
  if (!from || !dest.cell || !dest.valid)
    throw Error(dest.message ?? 'Start is outside planning map.');
  const planned =
    c.plannerMode === 'manual'
      ? undefined
      : planSynchronously({
          grid,
          collisionGrid: grid,
          start: from,
          goal: dest.cell,
          options: c.plannerOptions,
          footprint: c.footprint,
          startTheta: start.theta,
          goalTheta: target.theta,
          exactStartPose: start,
          exactGoalPose: goal,
          planningConfiguration: snapshot,
          plannerStrategy: c.plannerMode === 'motion-state' ? 'motion-state' : 'legacy',
        });
  if (planned && !planned.success) throw Error(planned.error ?? 'No valid route.');
  const path = planned?.finalPath ?? [start, goal];
  if (
    !new PathCollisionValidator().pathIsFree(
      grid,
      path,
      c.footprint,
      c.plannerOptions.collisionSampleInterval,
    )
  )
    throw Error('Route intersects an obstacle.');
  const order = new VdaOrderBuilder().build(
    path,
    {
      robotPose: start,
      activeMapId: start.mapId,
      finalGoalTheta: target.theta,
      motionPlan: planned?.motionPlan,
      planningConfiguration: snapshot,
      corridorPlanning: { grid, footprint: c.footprint, plannerOptions: c.plannerOptions },
    },
    c.orderSettings,
  );
  validateOrder(c, f, order, now);
  return order;
}
