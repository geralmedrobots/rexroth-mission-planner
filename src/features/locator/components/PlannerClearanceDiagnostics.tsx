import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useAppStore } from '../../../stores/appStore';
import { FootprintModel } from '../../../domain/geometry/FootprintModel';
import { ObstacleInflation } from '../../../domain/planner/ObstacleInflation';
import { DiagnosticPlannerRunner } from '../services/diagnosticPlannerRunner';
import { buildMotionStateClearanceField } from '../../../domain/planner/ClearanceField';
import { isOccupiedValue } from '../../../domain/planner/ObstacleInflation';
import type { OccupancyGrid, PathPoint, PlannerResult } from '../../../domain/types';
import type { PlanningInputs } from '../../planning/PlanningCoordinator';
import { effectiveDiagnosticFootprint, inspectDiagnosticPose, measureDoorway, precisePlannerOutcome,
  prepareClearanceRequest, rejectionEvidence, type CollisionEvidence } from '../services/plannerClearanceDiagnostics';

export interface ClearanceOverlay {
  inflated: OccupancyGrid;
  showInflation: boolean;
  showUnknown: boolean;
  start?: PathPoint;
  goal?: PathPoint;
  selected?: CollisionEvidence;
  physicalPolygon?: Array<{ x: number; y: number }>;
  doorway?: ReturnType<typeof measureDoorway>;
  evidence: CollisionEvidence[];
  path: PathPoint[];
  belowPassageSetting: boolean;
  hardMinimumCells: number[];
}

export function PlannerClearanceDiagnostics({ grid, pickRef, onOverlay }: {
  grid: OccupancyGrid;
  pickRef: RefObject<((point: { x: number; y: number }) => void) | undefined>;
  onOverlay: (overlay: ClearanceOverlay | undefined) => void;
}) {
  const footprint = useAppStore(s => s.footprint);
  const plannerOptions = useAppStore(s => s.plannerOptions);
  const plannerMode = useAppStore(s => s.plannerMode);
  const orderSettings = useAppStore(s => s.orderSettings);
  const savedGoalThetaExplicit = useAppStore(s => s.goalThetaExplicit);
  const savedStartHeading = useAppStore(s => s.start?.theta ?? 0);
  const savedGoalHeading = useAppStore(s => s.goal?.theta ?? 0);
  const [enforceGoal, setEnforceGoal] = useState(savedGoalThetaExplicit);
  const [target, setTarget] = useState<'start' | 'goal' | 'footprint'>('start');
  const [start, setStart] = useState<PathPoint>();
  const [goal, setGoal] = useState<PathPoint>();
  const [position, setPosition] = useState<PathPoint>();
  const [startDeg, setStartDeg] = useState(savedStartHeading * 180 / Math.PI);
  const [goalDeg, setGoalDeg] = useState(savedGoalHeading * 180 / Math.PI);
  const [poseDeg, setPoseDeg] = useState(savedStartHeading * 180 / Math.PI);
  const [showInflation, setShowInflation] = useState(true);
  const [showUnknown, setShowUnknown] = useState(true);
  const [showConstraints, setShowConstraints] = useState(true);
  const [result, setResult] = useState<PlannerResult>();
  const [evidence, setEvidence] = useState<CollisionEvidence[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const runner = useMemo(() => new DiagnosticPlannerRunner(), []);
  const effective = useMemo(() => effectiveDiagnosticFootprint({ footprint, plannerOptions, orderSettings }), [footprint, plannerOptions, orderSettings]);
  const displayRadius = plannerOptions.passageSafety.planningSafetyMarginM + plannerOptions.passageSafety.localizationMarginM;
  const inflated = useMemo(() => ObstacleInflation.byRadius(grid, displayRadius), [grid, displayRadius]);
  const hardMinimumCells = useMemo(() => {
    if (!showConstraints || plannerMode !== 'motion-state') return [];
    const field = buildMotionStateClearanceField(grid);
    return grid.data.flatMap((value, i) => !isOccupiedValue(value, grid.metadata.occupiedThreshold) &&
      field[i]! + 1e-9 < plannerOptions.passageSafety.wallClearanceMinimumM ? [i] : []);
  }, [grid, plannerMode, plannerOptions, showConstraints]);
  const a = useMemo(() => start ? { ...start, theta: startDeg * Math.PI / 180 } : undefined, [start, startDeg]);
  const b = useMemo(() => goal ? { ...goal, theta: goalDeg * Math.PI / 180 } : undefined, [goal, goalDeg]);
  const pose = useMemo(() => position ? { ...position, theta: poseDeg * Math.PI / 180 } : a, [position, poseDeg, a]);
  const doorway = useMemo(() => a && b ? measureDoorway(grid, a, b, effective) : undefined, [grid, a, b, effective]);
  const selected = useMemo(() => pose ? inspectDiagnosticPose(grid, pose, effective) : undefined, [grid, pose, effective]);
  const physicalPolygon = useMemo(() => pose ? FootprintModel.from({ ...footprint, safetyMargin: 0 }).polygonAt(pose) : undefined, [pose, footprint]);
  useEffect(() => {
    pickRef.current = point => {
      if (target === 'start') { setStart({ ...point, theta: 0 }); setTarget('goal'); }
      else if (target === 'goal') { setGoal({ ...point, theta: 0 }); setTarget('footprint'); }
      else setPosition({ ...point, theta: 0 });
    };
    return () => { pickRef.current = undefined; };
  }, [pickRef, target]);
  useEffect(() => {
    generation.current++; runner.cancel(); setResult(undefined); setEvidence([]); setError(''); setBusy(false);
  }, [grid, a, b, plannerOptions, footprint, plannerMode, orderSettings, enforceGoal, runner]);
  useEffect(() => () => { generation.current++; runner.cancel(); onOverlay(undefined); }, [onOverlay, runner]);
  const overlay = useMemo<ClearanceOverlay>(() => ({ inflated, showInflation, showUnknown, start: a, goal: b,
    selected, physicalPolygon, doorway, evidence, path: result?.finalPath ?? [],
    belowPassageSetting: Boolean(doorway && doorway.widthM < plannerOptions.passageSafety.minimumPassageWidthM), hardMinimumCells,
  }), [inflated, showInflation, showUnknown, a, b, selected, physicalPolygon, doorway, evidence, result, plannerOptions, hardMinimumCells]);
  useEffect(() => { onOverlay(overlay); }, [overlay, onOverlay]);

  async function run() {
    if (!a || !b) return;
    const id = ++generation.current; setBusy(true); setError(''); setResult(undefined); setEvidence([]);
    try {
      const inputs: PlanningInputs = structuredClone({ grid, start: { ...a, mapId: grid.metadata.mapId, positionInitialized: true },
        goal: { ...b, mapId: grid.metadata.mapId, positionInitialized: true }, waypoints: [],
        plannerMode, plannerOptions, footprint, orderSettings, goalThetaExplicit: enforceGoal, sessionId: 'locator-clearance-diagnostics' });
      const request = prepareClearanceRequest(inputs);
      const planned = await runner.plan(request);
      if (id !== generation.current) return;
      setResult(planned); setEvidence(rejectionEvidence(inputs.grid, planned, inputs));
    } catch (e) { if (id === generation.current) setError(String(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }

  return <Stack gap={0.75} sx={{ border: '1px solid', borderColor: 'divider', p: 1 }}>
    <Typography variant="subtitle2">Planner Clearance Diagnostics</Typography>
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
      <TextField select size="small" label="Map click sets" value={target} onChange={e => setTarget(e.target.value as typeof target)}>
        <MenuItem value="start">A: start side</MenuItem><MenuItem value="goal">B: goal side</MenuItem><MenuItem value="footprint">Robot footprint position</MenuItem>
      </TextField>
      {([['Start heading °', startDeg, setStartDeg], ['Goal heading °', goalDeg, setGoalDeg], ['Footprint heading °', poseDeg, setPoseDeg]] as const).map(([label, value, setter]) =>
        <TextField key={label} size="small" type="number" label={label} value={value} sx={{ width: 155 }}
          onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) setter(n); }}/>) }
      <FormControlLabel control={<Checkbox checked={Boolean(enforceGoal)} onChange={(_, v) => setEnforceGoal(v)}/>} label="Enforce diagnostic goal heading"/>
      <FormControlLabel control={<Checkbox checked={showInflation} onChange={(_, v) => setShowInflation(v)}/>} label="Inflation (orange)"/>
      <FormControlLabel control={<Checkbox checked={showUnknown} onChange={(_, v) => setShowUnknown(v)}/>} label="Unknown cells (grey)"/>
      <FormControlLabel control={<Checkbox checked={showConstraints} onChange={(_, v) => setShowConstraints(v)}/>} label="Hard minimum clearance (blue, motion-state)"/>
      <Button disabled={!a || !b || busy || plannerMode === 'manual'} onClick={() => void run()}>Run diagnostic planner</Button>
      <Button onClick={() => { generation.current++; setStart(undefined); setGoal(undefined); setPosition(undefined); setTarget('start'); setResult(undefined); setEvidence([]); }}>Reset doorway</Button>
    </Stack>
    <Typography variant="caption">Click A and B on the approach/exit sides of the doorway. The estimate samples cross-sections perpendicular to A→B; it is not the distance between clicks. Then click a footprint position. These selections and heading overrides are diagnostic only.</Typography>
    <Typography variant="body2">Planner: {plannerMode}; robot width {footprint.width.toFixed(3)} m; length {footprint.length.toFixed(3)} m; configured inflation radius {footprint.inflationRadius.toFixed(3)} m; displayed static inflation {displayRadius.toFixed(3)} m; effective footprint safety margin {effective.safetyMargin.toFixed(3)} m per side (max of footprint {footprint.safetyMargin.toFixed(3)} and planning + localization {displayRadius.toFixed(3)}).</Typography>
    <Typography variant="caption">The existing planner uses the raw grid plus the full expanded footprint; orange inflation is display-only, not a second collision grid. The configured inflation-radius field is not used by this planning request. Minimum passage setting {plannerOptions.passageSafety.minimumPassageWidthM.toFixed(3)} m is a legacy doorway-detection filter, not a motion-state hard cutoff. Motion-state hard minimum centre clearance: {plannerOptions.passageSafety.wallClearanceMinimumM.toFixed(3)} m.</Typography>
    <Typography variant="body2">{doorway
      ? `Estimated narrowest cross-section ${doorway.widthM.toFixed(3)} m; boundaries ${doorway.left.obstacle}/${doorway.right.obstacle}; projected robot span at start heading ${doorway.projectedWidthM.toFixed(3)} m; remaining span after footprint margin ${doorway.remainingWidthM.toFixed(3)} m; cell resolution ${doorway.resolutionM.toFixed(3)} m. ${doorway.blockedCentreSamples} blocked centreline samples. ${overlay.belowPassageSetting ? 'Below saved passage setting (purple boundary cells); this alone does not prove planner rejection.' : ''}`
      : 'Doorway clearance unavailable: select two distinct in-map positions with observed boundaries on both sides.'}</Typography>
    {selected && <Typography variant="body2">Selected footprint: {selected.reason}; source {selected.obstacle}{selected.cell ? ` at row ${selected.cell.row}, column ${selected.cell.column}` : ''}. White outline = configured body; cyan outline = body plus effective margin; magenta = colliding footprint.</Typography>}
    {busy && <Alert severity="info">Running the existing planner in its worker with a read-only snapshot of the current saved settings…</Alert>}
    {error && <Alert severity="error">{error}</Alert>}
    {result && <Alert severity={result.success ? 'success' : 'error'}>{precisePlannerOutcome(result)} ({result.statistics.durationMs.toFixed(0)} ms; {result.statistics.visitedCells} visited.)</Alert>}
    {result && <Typography variant="caption">{evidence.length} exact collision evidence records. Red = original occupied blocker; grey = unknown blocker; magenta outline = footprint collision. {evidence.length === 0 ? 'No exact blocking cells were returned or reproducible from the planner’s retained rejection evidence.' : ''} Search traces are bounded and do not identify every rejected candidate. A collision record does not prove all alternative paths are blocked.</Typography>}
    {evidence.map((item, i) => <Typography variant="caption" key={i}>{item.source}: {item.reason}; {item.obstacle}{item.cell ? ` row ${item.cell.row}, column ${item.cell.column}` : ' (map boundary)'}.</Typography>)}
  </Stack>;
}
