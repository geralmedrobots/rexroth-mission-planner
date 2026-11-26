import { randomUUID } from 'node:crypto';
import {
  steps,
  terminal,
  type DeliveryRun,
  type Phase,
  type Step,
} from '../src/features/pharmacy/model';
import type { VdaOrder, VdaState } from '../src/domain/types';
import { normalizeAngle } from '../src/domain/geometry/angles';
import { getActiveNavigatorOrderId } from '../src/features/mission/dispatchGate';
import { type Config, type Frame, planLeg, validateOrder } from './deliveryPlanning';

interface Ports {
  now: () => number;
  save: (r: DeliveryRun) => void;
  send: (order: VdaOrder) => void;
  cancel: (id: string) => void;
  plan?: typeof planLeg;
  validate?: typeof validateOrder;
}
function stationary(s: VdaState) {
  return (
    s.driving === false &&
    (!s.velocity ||
      [s.velocity.vx, s.velocity.vy, s.velocity.omega].every((v) => v === undefined || v === 0))
  );
}
function idle(s: VdaState) {
  return (
    stationary(s) &&
    s.nodeStates?.length === 0 &&
    s.edgeStates?.length === 0 &&
    !getActiveNavigatorOrderId(s)
  );
}
export class DeliveryEngine {
  run?: DeliveryRun;
  frame?: Frame;
  online = false;
  private candidate?: { order: VdaOrder; after: number };
  constructor(
    readonly config: Config,
    private ports: Ports,
    restored?: DeliveryRun,
    private sequence: readonly Step[] = steps,
  ) {
    if (restored) {
      this.run = structuredClone(restored);
      if (!terminal(restored))
        this.suspend('Backend restarted. Review the recorded step and robot state.');
    }
  }
  private commit(
    phase: Phase,
    message: string,
    patch: Partial<DeliveryRun> = {},
    eventIndex?: number,
  ) {
    const r = this.run!;
    const next = {
      ...r,
      ...patch,
      phase,
      revision: r.revision + 1,
      events: [
        ...r.events,
        { at: this.ports.now(), index: eventIndex ?? patch.index ?? r.index, message },
      ],
    };
    this.ports.save(next);
    this.run = next;
  }
  private ready() {
    const f = this.frame,
      t = this.ports.now(),
      timeout = this.config.orderSettings.stateStaleTimeoutMs;
    if (!this.online || !f || t - f.source > timeout || t - f.received > timeout || f.source > t)
      throw Error('Robot offline or state telemetry is stale.');
    const s = f.state,
      p = s.agvPosition;
    if (!p?.positionInitialized || !p.mapId || ![p.x, p.y, p.theta].every(Number.isFinite))
      throw Error('Fresh initialized Navigator localisation is required.');
    const score = (p as { localizationScore?: unknown }).localizationScore;
    if (score !== undefined || this.config.minQuality !== undefined) {
      if (
        this.config.minQuality === undefined ||
        typeof score !== 'number' ||
        !Number.isFinite(score) ||
        score < this.config.minQuality ||
        score > 1
      )
        throw Error('Localisation quality does not satisfy the commissioned score criterion.');
    }
    if (
      s.operatingMode !== 'AUTOMATIC' ||
      s.paused !== false ||
      s.safetyState?.eStop !== 'NONE' ||
      s.safetyState.fieldViolation !== false ||
      !Array.isArray(s.errors) ||
      s.errors.length ||
      typeof s.driving !== 'boolean' ||
      !Array.isArray(s.nodeStates) ||
      !Array.isArray(s.edgeStates)
    )
      throw Error('Navigator readiness, safety fields or execution faults prevent progression.');
    return f;
  }
  private at(name: string) {
    const f = this.ready(),
      p = f.state.agvPosition!,
      w = this.config.points[name],
      o = this.config.orderSettings;
    if (
      p.mapId !== w.mapId ||
      !idle(f.state) ||
      Math.hypot(p.x - w.x, p.y - w.y) > o.allowedDeviationXy ||
      Math.abs(normalizeAngle(p.theta - w.theta)) > o.allowedDeviationTheta
    )
      throw Error(`Verify stationary localisation at ${name} on ${w.mapId}.`);
  }
  preflight() {
    this.at(this.sequence[0]!.at);
  }
  start() {
    if (this.run && !terminal(this.run)) throw Error('A mission is already active.');
    this.preflight();
    const r: DeliveryRun = {
      id: randomUUID(),
      revision: 0,
      index: 0,
      phase: 'PREFLIGHT_VALIDATION',
      started: this.ports.now(),
      events: [],
    };
    this.ports.save(r);
    this.run = r;
    this.enter(0);
    this.tick();
  }
  private enter(index: number, confirmation?: string) {
    const step = this.sequence[index]!;
    const phase =
      step.kind === 'confirm' || step.kind === 'transition'
        ? step.state
        : step.kind === 'navigate'
          ? 'VALIDATING_ROUTE'
          : 'VERIFYING_LOCALISATION';
    this.candidate = undefined;
    this.commit(
      phase,
      confirmation ?? `Entered ${step.kind}: ${step.at}`,
      { index, reason: undefined, order: undefined, cancelId: undefined },
      confirmation ? this.run!.index : index,
    );
  }
  private advance(name: string) {
    this.commit(this.run!.phase, `Verified ${name}`, { lastVerified: name });
    this.enter(this.run!.index + 1);
  }
  guard(id: string, revision: number) {
    if (!this.run || this.run.id !== id || this.run.revision !== revision || terminal(this.run))
      throw Error('Obsolete mission or step. Refresh mission status.');
  }
  confirm(id: string, revision: number) {
    this.guard(id, revision);
    const r = this.run!,
      step = this.sequence[r.index]!;
    if ((step.kind !== 'confirm' && step.kind !== 'transition') || r.phase !== step.state)
      throw Error('No matching confirmation is pending.');
    this.checkWaiting(step);
    this.enter(r.index + 1, 'Operator confirmed: ' + step.prompt);
  }
  private checkWaiting(step: Step) {
    const f = this.ready();
    const destination = step.kind === 'transition' ? step.destination : undefined;
    this.at(
      destination && f.state.agvPosition!.mapId === this.config.points[destination].mapId
        ? destination
        : step.at,
    );
  }
  suspend(reason: string) {
    if (!this.run || terminal(this.run)) return;
    this.candidate = undefined;
    if (this.run.phase !== 'RECOVERY_REQUIRED' || this.run.reason !== reason)
      this.commit('RECOVERY_REQUIRED', reason, { reason });
  }
  private arrived() {
    const r = this.run!,
      o = r.order!,
      f = this.ready(),
      s = f.state;
    if (
      f.source <= o.issued ||
      s.orderId !== o.id ||
      s.orderUpdateId !== 0 ||
      s.lastNodeId !== o.lastNode ||
      s.lastNodeSequenceId !== o.sequence ||
      s.nodeStates!.length ||
      s.edgeStates!.length ||
      !stationary(s)
    )
      throw Error('Matching completed order and stationary final-node feedback are required.');
    this.at(this.sequence[r.index]!.at);
  }
  feedback(frame: Frame) {
    if (this.frame && frame.source <= this.frame.source) return;
    this.frame = frame;
    this.tick(true);
  }
  disconnect() {
    this.online = false;
    this.frame = undefined;
    this.suspend('Robot communication lost. Physical execution is unconfirmed.');
  }
  tick(fresh = false) {
    const r = this.run;
    if (!r || terminal(r) || r.phase === 'RECOVERY_REQUIRED') return;
    try {
      const f = this.ready(),
        s = f.state,
        step = this.sequence[r.index]!,
        target = this.config.points[step.at];
      if (r.cancelId) {
        const a = s.actionStates?.find(
          (v) => (v as { actionId?: string })?.actionId === r.cancelId,
        ) as { actionStatus?: string } | undefined;
        if (a?.actionStatus === 'FINISHED' && idle(s))
          this.commit('CANCELLED', 'Cancellation acknowledged and stationary state observed.', {
            ended: this.ports.now(),
          });
        else if (
          a?.actionStatus === 'FAILED' ||
          this.ports.now() - r.events.at(-1)!.at > this.config.orderSettings.commandTimeoutMs
        )
          throw Error('Cancellation outcome uncertain.');
        return;
      }
      if (step.kind === 'confirm' || step.kind === 'transition') {
        this.checkWaiting(step);
        return;
      }
      if (step.kind === 'localise') {
        if (
          s.agvPosition!.mapId !== target.mapId &&
          r.lastVerified &&
          this.sequence[r.index - 1]?.kind === 'transition'
        ) {
          this.at(r.lastVerified);
          return;
        }
        this.at(step.at);
        if (r.index === 0 || (fresh && f.source > r.events.at(-1)!.at)) this.advance(step.at);
        return;
      }
      if (step.kind === 'complete') {
        this.at(step.at);
        this.commit('COMPLETED', 'Arrival at charging station verified.', {
          ended: this.ports.now(),
          charging: s.batteryState?.charging,
        });
        return;
      }
      if (s.agvPosition!.mapId !== target.mapId)
        throw Error('Active map differs from the navigation target.');
      if (r.order) {
        if (
          !fresh &&
          this.ports.now() - r.order.issued <= this.config.orderSettings.acceptanceTimeoutMs
        )
          return;
        if (s.orderId !== r.order.id) {
          if (
            r.order.accepted ||
            getActiveNavigatorOrderId(s) ||
            this.ports.now() - r.order.issued > this.config.orderSettings.acceptanceTimeoutMs
          )
            throw Error('Order acceptance or ownership is uncertain.');
          return;
        }
        if (f.source <= r.order.issued) return;
        if (s.orderUpdateId !== 0) throw Error('Unexpected order update.');
        if (!r.order.accepted)
          this.commit('NAVIGATING', 'Navigator accepted order.', {
            order: { ...r.order, accepted: true },
          });
        if (s.lastNodeSequenceId === r.order.sequence && !s.driving) {
          this.commit('VERIFYING_ARRIVAL', 'Checking final node and waypoint pose.');
          this.arrived();
          this.advance(step.at);
        } else if (stationary(s) && s.nodeStates!.length === 0 && s.edgeStates!.length === 0) {
          throw Error('Navigator is idle without matching final-node completion evidence.');
        }
        return;
      }
      if (!r.lastVerified) throw Error('Missing verified departure waypoint.');
      this.at(r.lastVerified);
      if (!fresh) return;
      if (!this.candidate) {
        const order = (this.ports.plan ?? planLeg)(this.config, f, target, this.ports.now());
        this.candidate = { order, after: this.ports.now() };
        return;
      }
      if (f.source <= this.candidate.after) return;
      const order = this.candidate.order;
      (this.ports.validate ?? validateOrder)(this.config, f, order, this.ports.now());
      this.ready();
      const last = order.nodes.at(-1)!;
      this.commit('NAVIGATING', `Dispatch intent ${order.orderId}`, {
        order: {
          id: order.orderId,
          lastNode: last.nodeId,
          sequence: last.sequenceId,
          issued: this.ports.now(),
        },
      });
      this.candidate = undefined;
      this.ports.send(order);
    } catch (e) {
      this.suspend(e instanceof Error ? e.message : String(e));
    }
  }
  review(id: string, revision: number) {
    this.guard(id, revision);
    const r = this.run!;
    if (r.phase !== 'RECOVERY_REQUIRED')
      throw Error('Review is only available for suspended missions.');
    this.ready();
    if (r.cancelId) throw Error('Reconcile the cancellation and end the run.');
    if (r.order) {
      this.arrived();
      this.commit('VERIFYING_ARRIVAL', 'Operator reconciled completed order.');
      this.advance(this.sequence[r.index]!.at);
      return;
    }
    const step = this.sequence[r.index]!;
    if (step.kind === 'navigate' && r.lastVerified) this.at(r.lastVerified);
    else if (step.kind === 'transition') this.checkWaiting(step);
    else this.at(step.at);
    this.enter(r.index);
  }
  cancel(id: string, revision: number) {
    this.guard(id, revision);
    const r = this.run!,
      f = this.ready();
    if (r.cancelId) throw Error('Cancellation has already been requested. Review Navigator.');
    if (
      r.order &&
      f.state.orderId === r.order.id &&
      getActiveNavigatorOrderId(f.state) === r.order.id
    ) {
      const cancelId = randomUUID();
      this.commit('CANCELLING', 'Operator requested cancelOrder.', { cancelId });
      try {
        this.ports.cancel(cancelId);
      } catch {
        this.suspend('Cancellation handoff is uncertain.');
      }
      return;
    }
    if (r.order) throw Error('Order outcome uncertain. Verify Navigator before ending tracking.');
    if (!idle(f.state)) throw Error('Stationary, idle robot feedback required.');
    this.commit('CANCELLED', 'Operator cancelled the remaining mission.', {
      ended: this.ports.now(),
    });
  }
  endReviewed(id: string, revision: number) {
    this.guard(id, revision);
    const f = this.ready();
    if (this.run!.phase !== 'RECOVERY_REQUIRED' || !idle(f.state))
      throw Error('Review requires stationary idle feedback.');
    this.commit(
      'CANCELLED',
      'Operator reconciled Navigator and ended the mission. No stop command issued.',
      { ended: this.ports.now() },
    );
  }
}
