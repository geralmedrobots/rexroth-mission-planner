import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { useAppStore } from '../../stores/appStore';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { locatorMapService } from '../locator/services/locatorMapService';
import { useDestinationStore } from '../destinations/destinationStore';
import { useOperatorSettingsStore } from '../settings/operatorSettingsStore';
import { deliveryRequest } from './deliveryApi';
import { names, steps, stages, terminal, pharmacyTitle, type DeliveryView } from './model';

export function DeliveryConsole({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<DeliveryView>(),
    [error, setError] = useState(''),
    [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false),
    [dismissed, setDismissed] = useState(''),
    [decision, setDecision] = useState('');
  const version = useRef(0),
    working = useRef(false);
  const decisionTarget = useRef<{ id?: string; revision?: number; prepared?: string }>({});
  const choose = (op: string) => {
    decisionTarget.current = {
      id: view?.run?.id,
      revision: view?.run?.revision,
      prepared: view?.prepared,
    };
    setDecision(op);
  };
  const currentPoints = () =>
    useDestinationStore
      .getState()
      .destinations.filter((p) => names.some((n) => p.displayName === n));
  const runId = view?.run && !terminal(view.run) ? view.run.id : undefined;
  useEffect(() => {
    if (!runId) return;
    let disposed = false,
      sending = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let synchronized = JSON.stringify(currentPoints());
    const retryMessage =
      'Waypoint edits could not be checked against the active mission. Retrying.';
    async function synchronize() {
      if (disposed || sending) return;
      const points = currentPoints(),
        snapshot = JSON.stringify(points);
      if (snapshot === synchronized) return;
      sending = true;
      try {
        await deliveryRequest('waypoints', { id: runId, points });
        synchronized = snapshot;
        if (!disposed) setError((previous) => (previous === retryMessage ? '' : previous));
      } catch {
        if (!disposed) setError(retryMessage);
      } finally {
        sending = false;
        if (!disposed && JSON.stringify(currentPoints()) !== synchronized) {
          clearTimeout(timer);
          timer = setTimeout(() => void synchronize(), 1000);
        }
      }
    }
    const unsubscribe = useDestinationStore.subscribe(() => void synchronize());
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [runId]);
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const n = version.current;
      try {
        const data = await deliveryRequest();
        if (mounted && n === version.current) {
          setView(data);
          setOffline(false);
        }
      } catch {
        if (mounted && n === version.current) setOffline(true);
      }
      if (mounted) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, []);
  const r = view?.run,
    step = r && steps[r.index],
    active = !!r && !terminal(r);
  const pending =
    !!r && (step?.kind === 'confirm' || step?.kind === 'transition') && r.phase === step.state;
  const key = r ? `${r.id}:${r.revision}` : '';
  const locator = useLocatorStore.getState();
  async function act(op: string) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    version.current++;
    try {
      const live = useAppStore.getState();
      let data: unknown = { id: r?.id, revision: r?.revision };
      if (op === 'map') {
        if (!locator.loadedMap) throw Error('Select and load a Locator raster first.');
        const { occupancy } = await locatorMapService.toOccupancy(
          locator.loadedMap,
          locator.settings,
        );
        data = { grid: occupancy, locatorMapName: locator.loadedMap.mapName };
      } else if (op === 'prepare') {
        data = {
          mqttSettings: live.mqttSettings,
          orderSettings: live.orderSettings,
          plannerMode: live.plannerMode,
          plannerOptions: live.plannerOptions,
          footprint: live.footprint,
          points: useDestinationStore
            .getState()
            .destinations.filter((p) => names.some((n) => p.displayName === n)),
          nodeLimit: useOperatorSettingsStore.getState().settings.maximumVdaNodeCount,
        };
      } else if (op === 'start')
        data = { prepared: decisionTarget.current.prepared, points: currentPoints() };
      else if (op === 'review' || op === 'end' || op === 'cancel')
        data = { ...decisionTarget.current, points: currentPoints() };
      else if (op === 'reconnect')
        data = { id: r?.id, revision: r?.revision, password: live.mqttSettings.password };
      const next = await deliveryRequest(op, data);
      setView(next);
      setOffline(false);
      setDecision('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      version.current++;
      working.current = false;
      setBusy(false);
    }
  }
  const awaiting = pending && dismissed !== key && !offline;
  return (
    <>
      <Dialog
        open={open && !awaiting}
        onClose={onClose}
        fullWidth
        maxWidth="sm"
        aria-labelledby="delivery-title"
      >
        <DialogTitle id="delivery-title">{pharmacyTitle}</DialogTitle>
        <DialogContent>
          <Stack gap={1.4}>
            {offline && (
              <Alert severity="error">
                Mission service unavailable. Last shown status may be stale.
              </Alert>
            )}
            {(error || view?.problem) && <Alert severity="warning">{error || view?.problem}</Alert>}
            <Typography variant="body2">
              {view?.connected && !offline ? 'Robot connected' : 'Robot connection unavailable'} ·{' '}
              {offline ? 'Localisation unavailable' : view?.localisation} · Map{' '}
              {offline ? 'unknown' : (view?.floor ?? 'unknown')}
            </Typography>
            {!active && (
              <>
                <Typography>
                  Register the loaded Locator raster for each floor, then check the seven saved
                  waypoints and robot readiness at Charging station.
                </Typography>
                {view?.readiness && <Alert severity="info">{view.readiness}</Alert>}
                <Typography variant="body2">
                  Registered maps · {view?.maps.join(', ') || 'None'}
                </Typography>
                <Button
                  variant="outlined"
                  disabled={busy || !locator.loadedMap || offline}
                  onClick={() => void act('map')}
                >
                  Register loaded Locator map
                </Button>
                <Button
                  disabled={busy || offline}
                  variant="outlined"
                  onClick={() => void act('prepare')}
                >
                  Prepare mission
                </Button>
                <Button
                  disabled={
                    busy || offline || !view?.prepared || !!view.readiness || !view.connected
                  }
                  variant="contained"
                  onClick={() => choose('start')}
                >
                  Start pharmacy delivery
                </Button>
              </>
            )}
            {r && (
              <>
                <Typography variant="h3">
                  {r.phase.replaceAll('_', ' ')} · Stage {step?.stage}
                </Typography>
                <Typography variant="body2">
                  Current · {step?.at}
                  <br />
                  Next · {steps[r.index + 1]?.at ?? '—'}
                  <br />
                  Progress · {r.phase === 'COMPLETED' ? steps.length : r.index}/{steps.length} steps
                  · {Math.max(0, Math.floor(((r.ended ?? Date.now()) - r.started) / 1000))} s
                </Typography>
                {r.reason && (
                  <Alert severity="warning">
                    {r.reason}
                    {r.order
                      ? ' Verify the physical robot. Suspending progression does not stop an outstanding order.'
                      : ''}
                  </Alert>
                )}
                {r.phase === 'VERIFYING_LOCALISATION' && (
                  <Alert severity="info">
                    Use the commissioned Locator/Navigator procedure to select the destination map
                    and localise at the elevator reference. The bridge waits for current robot
                    feedback.
                  </Alert>
                )}
                {pending && (
                  <Button onClick={() => setDismissed('')}>Open pending confirmation</Button>
                )}
                {r.phase === 'COMPLETED' && (
                  <Alert severity="success">
                    Round trip completed at Charging station.{' '}
                    {r.charging === true
                      ? 'Telemetry confirmed charging at arrival.'
                      : 'Charging was not confirmed at arrival.'}
                  </Alert>
                )}
                {r.phase === 'RECOVERY_REQUIRED' && (
                  <>
                    <Button disabled={busy || offline} onClick={() => void act('reconnect')}>
                      Reconnect telemetry
                    </Button>
                    <Button disabled={busy || offline} onClick={() => choose('review')}>
                      Review and authorize recovery
                    </Button>
                    <Button disabled={busy || offline} onClick={() => choose('end')}>
                      Reconcile and end run
                    </Button>
                  </>
                )}
                {active && (
                  <Button
                    color="error"
                    disabled={busy || offline || r.phase === 'CANCELLING'}
                    onClick={() => choose('cancel')}
                  >
                    Cancel delivery
                  </Button>
                )}
              </>
            )}
            <ol className="delivery-timeline">
              {stages.map((name, i) => {
                const stage = String.fromCharCode(65 + i),
                  order = steps.filter((s) => s.stage === stage),
                  current = step?.stage === stage;
                const status =
                  r?.phase === 'COMPLETED' || (step && stage < step.stage)
                    ? 'Completed'
                    : current
                      ? r?.phase === 'RECOVERY_REQUIRED'
                        ? 'Recovery required'
                        : r?.phase === 'CANCELLED'
                          ? 'Cancelled'
                          : pending
                            ? 'Waiting for confirmation'
                            : 'Active'
                      : 'Pending';
                return (
                  <li key={name} data-status={status}>
                    <strong>
                      {stage} · {name}
                    </strong>{' '}
                    · {status}
                    <div>
                      {order.map((s, j) => (
                        <div key={j}>
                          {s.kind === 'navigate'
                            ? 'Navigate'
                            : s.kind === 'localise'
                              ? 'Verify pose'
                              : 'prompt' in s
                                ? s.prompt
                                : 'Complete'}{' '}
                          · {s.at}
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
            {r && (
              <details>
                <summary>Mission history · {r.id}</summary>
                {r.events.map((e, i) => (
                  <Typography key={i} variant="body2">
                    {new Date(e.at).toLocaleString()} · Step {e.index + 1} · {e.message}
                  </Typography>
                ))}
              </details>
            )}
            {view?.archive.map((old) => (
              <details key={old.id}>
                <summary>
                  {new Date(old.started).toLocaleString()} · {old.phase}
                </summary>
                {old.events.map((e, i) => (
                  <div key={i}>
                    {new Date(e.at).toLocaleString()} · {e.message}
                  </div>
                ))}
              </details>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
      {awaiting && step && (step.kind === 'confirm' || step.kind === 'transition') && (
        <Dialog open aria-labelledby="checkpoint-title" onClose={() => setDismissed(key)}>
          <DialogTitle id="checkpoint-title">{step.prompt}</DialogTitle>
          <DialogContent>
            <Typography>
              {pharmacyTitle} · Stage {step.stage} · Step {r!.index + 1} · {step.at}
            </Typography>
            <Typography variant="caption">Mission {r!.id}</Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDismissed(key)}>Not yet.</Button>
            <Button disabled={busy} variant="contained" onClick={() => void act('confirm')}>
              {step.yes}
            </Button>
          </DialogActions>
        </Dialog>
      )}
      <Dialog open={!!decision} onClose={() => setDecision('')}>
        <DialogTitle>
          {decision === 'start'
            ? 'Authorize the complete delivery mission?'
            : decision === 'review'
              ? 'Authorize recovery at the recorded step?'
              : decision === 'end'
                ? 'Confirm Navigator was reconciled and end this run?'
                : 'Cancel the remaining delivery?'}
        </DialogTitle>
        <DialogContent>
          {decision === 'start'
            ? `All nine same-floor orders use the configured speed of ${view?.speed ?? 'unknown'} m/s. Six supervised checkpoints are mandatory.`
            : 'Check the actual robot, order and elevator before proceeding. A request alone does not establish a physical stop.'}
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDecision('')}>Back</Button>
          <Button disabled={busy || offline} onClick={() => void act(decision)}>
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
