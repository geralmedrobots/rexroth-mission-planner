import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl,
  FormControlLabel, Grid, InputLabel, MenuItem, Paper, Select, Stack, Switch,
  TextField, Typography,
} from '@mui/material';
import { useGlobalReplanningStore } from './globalReplanningStore';
import { useRecoveryStore } from '../recovery/recoveryStore';

interface Props {
  open:boolean;
  onClose:()=>void;
  onEnableChange:(enabled:boolean)=>Promise<void>;
}

const seconds=(milliseconds:number):number=>milliseconds/1_000;

export const GlobalReplanningPanel=({open,onClose,onEnableChange}:Props)=>{
  const store=useGlobalReplanningStore();
  const settings=store.settings;const runtime=store.runtime;
  const recovery=useRecoveryStore();
  const ctrlx=recovery.settings.telemetry.ctrlx;
  const updateCtrlx=(patch:Partial<typeof ctrlx>):void=>recovery.updateSettings({
    telemetry:{
      ...recovery.settings.telemetry,
      ctrlx:{...ctrlx,...patch},
    },
  });
  const numberField=(
    label:string,value:number,onChange:(value:number)=>void,options?:{
      min?:number;max?:number;step?:number;
    },
  )=><TextField fullWidth size="small" label={label} type="number" value={value}
    inputProps={{min:options?.min,max:options?.max,step:options?.step}}
    onChange={(event)=>onChange(Number(event.target.value))}/>;
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
    <DialogTitle>Global Replanning</DialogTitle>
    <DialogContent>
      <Alert severity="warning" sx={{mb:2}}>
        Automatic global replanning can cancel an active Order and publish a replacement without
        further operator interaction. It is not obstacle avoidance and it is not a safety function.
      </Alert>
      <Paper variant="outlined" sx={{p:1.5,mb:2}}>
        <Stack direction={{xs:'column',md:'row'}} gap={2} alignItems={{md:'center'}}>
          <FormControlLabel control={<Switch checked={settings.enabled}
            onChange={(event)=>void onEnableChange(event.target.checked)}/>}
            label="Enable automatic replanning"/>
          <Typography variant="body2">Status: <strong>{runtime.status}</strong></Typography>
          <Typography variant="body2">Reason: {runtime.reason??'—'}</Typography>
          <Typography variant="body2">Blocked: {(runtime.blockedDurationMs/1_000).toFixed(1)} s</Typography>
        </Stack>
      </Paper>
      <Grid container spacing={1.5}>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Local bypass wait (s)',
          seconds(settings.localBypassWaitTimeMs),(value)=>store.updateSettings({
            localBypassWaitTimeMs:Math.max(0,value)*1_000,
          }),{min:0,max:120,step:.5})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Blocked timeout (s)',
          seconds(settings.blockedTimeoutMs),(value)=>store.updateSettings({
            blockedTimeoutMs:Math.max(1,value)*1_000,
          }),{min:1,max:120,step:.5})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Minimum obstacle size (m)',
          settings.minimumObstacleSizeM,(value)=>store.updateSettings({
            minimumObstacleSizeM:Math.max(.01,value),
          }),{min:.01,max:5,step:.05})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Inflation distance (m)',
          settings.inflationDistanceM,(value)=>store.updateSettings({
            inflationDistanceM:Math.max(0,value),
          }),{min:0,max:2,step:.05})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Maximum planning time (ms)',
          settings.maximumPlanningTimeMs,(value)=>store.updateSettings({
            maximumPlanningTimeMs:Math.max(50,value),
          }),{min:50,max:30000,step:50})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Maximum planning attempts',
          settings.maximumPlanningAttempts,(value)=>store.updateSettings({
            maximumPlanningAttempts:Math.max(1,Math.floor(value)),
          }),{min:1,max:10,step:1})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Retry delay (ms)',
          settings.retryDelayMs,(value)=>store.updateSettings({
            retryDelayMs:Math.max(100,value),
          }),{min:100,max:60000,step:100})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Maximum retries',
          settings.maximumRetries,(value)=>store.updateSettings({
            maximumRetries:Math.max(1,Math.floor(value)),
          }),{min:1,max:10,step:1})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField('Minimum route change (m)',
          settings.minimumRouteChangeM,(value)=>store.updateSettings({
            minimumRouteChangeM:Math.max(0,value),
          }),{min:0,max:5,step:.05})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>
          <FormControlLabel control={<Switch checked={settings.enableStartPoseProjection}
            onChange={(event)=>store.updateSettings({
              enableStartPoseProjection:event.target.checked,
            })}/>} label="Enable start pose projection"/>
        </Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField(
          'Maximum start projection (m)',
          settings.maximumStartProjectionDistanceM,(value)=>store.updateSettings({
            maximumStartProjectionDistanceM:Math.max(0,value),
          }),{min:0,max:2,step:.05})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>{numberField(
          'Post-replacement grace period (s)',
          seconds(settings.postReplacementGraceMs),(value)=>store.updateSettings({
            postReplacementGraceMs:Math.max(0,value)*1_000,
          }),{min:0,max:120,step:1})}</Grid>
        <Grid size={{xs:12,sm:6,md:4}}>
          <FormControlLabel control={<Switch checked={settings.unknownCellsBlocked}
            onChange={(event)=>store.updateSettings({unknownCellsBlocked:event.target.checked})}/>}
            label="Treat unknown cells as blocked"/>
        </Grid>
      </Grid>
      <Paper variant="outlined" sx={{p:1.5,mt:2}}>
        <Typography variant="overline">Blocked-robot recovery</Typography>
        <Alert severity="warning" sx={{mb:1.5}}>
          Reverse recovery uses Navigator Orders only. It never commands motors directly and
          remains blocked unless rear sensing and backward driving mode are confirmed.
        </Alert>
        <Grid container spacing={1.5}>
          <Grid size={{xs:12,sm:6,md:4}}>
            <FormControlLabel control={<Switch checked={recovery.settings.enabled}
              onChange={(event)=>recovery.updateSettings({enabled:event.target.checked})}/>}
              label="Enable automatic recovery"/>
          </Grid>
          <Grid size={{xs:12,sm:6,md:4}}>{numberField('Recovery blocked timeout (s)',
            seconds(recovery.settings.blockedTimeoutMs),(value)=>recovery.updateSettings({
              blockedTimeoutMs:Math.max(1,value)*1_000,
            }),{min:1,max:120,step:.5})}</Grid>
          <Grid size={{xs:12,sm:6,md:4}}>{numberField('Reverse recovery distance (m)',
            recovery.settings.reverseDistanceM,(value)=>recovery.updateSettings({
              reverseDistanceM:Math.max(.1,Math.min(
                value,recovery.settings.maximumReverseDistanceM)),
            }),{min:.1,max:1,step:.05})}</Grid>
          <Grid size={{xs:12,sm:6,md:4}}>{numberField('Maximum reverse distance (m)',
            recovery.settings.maximumReverseDistanceM,(value)=>recovery.updateSettings({
              maximumReverseDistanceM:Math.max(recovery.settings.reverseDistanceM,
                Math.min(1,value)),
            }),{min:.1,max:1,step:.05})}</Grid>
          <Grid size={{xs:12,sm:6,md:4}}>{numberField('Rear safety margin (m)',
            recovery.settings.rearSafetyMarginM,(value)=>recovery.updateSettings({
              rearSafetyMarginM:Math.max(0,value),
            }),{min:0,max:1,step:.05})}</Grid>
          <Grid size={{xs:12,sm:6,md:4}}>{numberField('Recovery retry count',
            recovery.settings.retryCount,(value)=>recovery.updateSettings({
              retryCount:Math.max(0,Math.min(5,Math.floor(value))),
            }),{min:0,max:5,step:1})}</Grid>
          <Grid size={{xs:12,sm:6,md:4}}>
            <FormControlLabel control={<Switch
              checked={recovery.settings.requireRearLaserData}
              onChange={(event)=>recovery.updateSettings({
                requireRearLaserData:event.target.checked,
              })}/>} label="Require rear Laser 2 data"/>
          </Grid>
          <Grid size={{xs:12,sm:6,md:4}}>
            <FormControl fullWidth size="small">
              <InputLabel>Driving mode telemetry source</InputLabel>
              <Select label="Driving mode telemetry source"
                value={recovery.settings.telemetry.source}
                onChange={(event)=>recovery.updateSettings({
                  telemetry:{
                    ...recovery.settings.telemetry,
                    source:event.target.value as 'ctrlx'|'mqtt-raw'|'disabled',
                  },
                })}>
                <MenuItem value="ctrlx">ctrlX DataLayer</MenuItem>
                <MenuItem value="mqtt-raw">MQTT raw payload</MenuItem>
                <MenuItem value="disabled">Disabled</MenuItem>
              </Select>
            </FormControl>
          </Grid>
        </Grid>
        {recovery.settings.telemetry.source==='ctrlx'&&<>
          <Typography variant="overline" sx={{display:'block',mt:1.5}}>
            ctrlX DataLayer connection
          </Typography>
          <Alert severity="info" sx={{mb:1.5}}>
            Enter the installed DataLayer endpoint and node paths. No Bosch path is assumed.
            The endpoint must contain the {'{path}'} placeholder.
          </Alert>
          <Grid container spacing={1.5}>
            <Grid size={{xs:12,sm:6,md:4}}>
              <TextField fullWidth size="small" label="Host" value={ctrlx.host}
                onChange={(event)=>updateCtrlx({host:event.target.value})}/>
            </Grid>
            <Grid size={{xs:12,sm:6,md:4}}>{numberField('Port',ctrlx.port,
              (value)=>updateCtrlx({port:Math.max(1,Math.min(65535,Math.floor(value)))}),
              {min:1,max:65535,step:1})}</Grid>
            <Grid size={{xs:12,sm:6,md:4}}>
              <FormControlLabel control={<Switch checked={ctrlx.https}
                onChange={(event)=>updateCtrlx({https:event.target.checked})}/>}
                label="HTTPS"/>
            </Grid>
            <Grid size={{xs:12}}>
              <TextField fullWidth size="small" label="DataLayer read endpoint template"
                placeholder="/configured/read/endpoint?node={path}"
                value={ctrlx.endpointTemplate}
                onChange={(event)=>updateCtrlx({endpointTemplate:event.target.value})}/>
            </Grid>
            <Grid size={{xs:12,sm:6,md:4}}>
              <FormControl fullWidth size="small">
                <InputLabel>Authentication</InputLabel>
                <Select label="Authentication" value={ctrlx.authenticationMode}
                  onChange={(event)=>updateCtrlx({
                    authenticationMode:event.target.value as 'none'|'basic'|'bearer',
                  })}>
                  <MenuItem value="none">None</MenuItem>
                  <MenuItem value="basic">Basic</MenuItem>
                  <MenuItem value="bearer">Bearer token</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            {ctrlx.authenticationMode==='basic'&&<>
              <Grid size={{xs:12,sm:6,md:4}}>
                <TextField fullWidth size="small" label="Username" value={ctrlx.username}
                  onChange={(event)=>updateCtrlx({username:event.target.value})}/>
              </Grid>
              <Grid size={{xs:12,sm:6,md:4}}>
                <TextField fullWidth size="small" label="Password" type="password"
                  autoComplete="new-password" value={ctrlx.password}
                  onChange={(event)=>updateCtrlx({password:event.target.value})}/>
              </Grid>
            </>}
            {ctrlx.authenticationMode==='bearer'&&
              <Grid size={{xs:12,sm:6,md:8}}>
                <TextField fullWidth size="small" label="Bearer token" type="password"
                  autoComplete="new-password" value={ctrlx.bearerToken}
                  onChange={(event)=>updateCtrlx({bearerToken:event.target.value})}/>
              </Grid>}
            <Grid size={{xs:12,sm:6}}>
              <TextField fullWidth size="small" label="requestDrivingMode path"
                value={ctrlx.requestDrivingModePath}
                onChange={(event)=>updateCtrlx({requestDrivingModePath:event.target.value})}/>
            </Grid>
            <Grid size={{xs:12,sm:6}}>
              <TextField fullWidth size="small" label="motionCommand.v_x path"
                value={ctrlx.commandedVxPath}
                onChange={(event)=>updateCtrlx({commandedVxPath:event.target.value})}/>
            </Grid>
            <Grid size={{xs:12,sm:6}}>
              <TextField fullWidth size="small" label="motionCommand.yaw_rate path"
                value={ctrlx.commandedYawRatePath}
                onChange={(event)=>updateCtrlx({commandedYawRatePath:event.target.value})}/>
            </Grid>
            <Grid size={{xs:12,sm:6}}>
              <TextField fullWidth size="small" label="availableDrivingModes path"
                value={ctrlx.availableDrivingModesPath}
                onChange={(event)=>updateCtrlx({availableDrivingModesPath:event.target.value})}/>
            </Grid>
            <Grid size={{xs:12,sm:6,md:4}}>{numberField('Polling interval (ms)',
              ctrlx.pollingIntervalMs,(value)=>updateCtrlx({
                pollingIntervalMs:Math.max(20,Math.min(10_000,value)),
              }),{min:20,max:10000,step:20})}</Grid>
            <Grid size={{xs:12,sm:6,md:4}}>{numberField('Telemetry stale timeout (ms)',
              ctrlx.staleTimeoutMs,(value)=>updateCtrlx({
                staleTimeoutMs:Math.max(100,Math.min(60_000,value)),
              }),{min:100,max:60000,step:100})}</Grid>
            <Grid size={{xs:12,sm:6,md:4}}>{numberField('Request timeout (ms)',
              ctrlx.requestTimeoutMs,(value)=>updateCtrlx({
                requestTimeoutMs:Math.max(100,Math.min(60_000,value)),
              }),{min:100,max:60000,step:100})}</Grid>
            <Grid size={{xs:12,sm:6,md:4}}>
              <FormControlLabel control={<Switch checked={ctrlx.rejectUnauthorized}
                onChange={(event)=>updateCtrlx({
                  rejectUnauthorized:event.target.checked,
                })}/>} label="Validate TLS certificate"/>
            </Grid>
          </Grid>
        </>}
        <Typography variant="overline" sx={{display:'block',mt:1.5}}>
          Recovery diagnostics
        </Typography>
        <Grid container spacing={1}>
          <Grid size={{xs:6,md:3}}>State: {recovery.runtime.state}</Grid>
          <Grid size={{xs:6,md:3}}>Forward blocked: {
            recovery.runtime.forwardBlocked?'Yes':'No'}</Grid>
          <Grid size={{xs:6,md:3}}>Turn space: {
            recovery.runtime.turnSpaceAvailable===undefined?'—':
              recovery.runtime.turnSpaceAvailable?'Available':'Unsafe'}</Grid>
          <Grid size={{xs:6,md:3}}>Reverse space: {
            recovery.runtime.reverseSpaceAvailable===undefined?'—':
              recovery.runtime.reverseSpaceAvailable?'Available':'Blocked'}</Grid>
          <Grid size={{xs:6,md:3}}>Reverse distance: {
            recovery.runtime.reverseDistanceSelectedM?.toFixed(2)??'—'} m</Grid>
          <Grid size={{xs:6,md:3}}>Rear obstacles: {
            recovery.runtime.rearObstacleCount}</Grid>
          <Grid size={{xs:6,md:3}}>Driving mode: {
            recovery.runtime.requestedDrivingMode===null||
              recovery.runtime.requestedDrivingMode===undefined?'—':
              `0x${recovery.runtime.requestedDrivingMode.toString(16).padStart(2,'0')}`}</Grid>
          <Grid size={{xs:6,md:3}}>motionCommand.v_x: {
            recovery.runtime.commandedVx?.toFixed(3)??'—'} m/s</Grid>
          <Grid size={{xs:6,md:3}}>motionCommand.yaw_rate: {
            recovery.runtime.commandedYawRate?.toFixed(3)??'—'} rad/s</Grid>
          <Grid size={{xs:6,md:3}}>Telemetry provider: {
            recovery.runtime.telemetryProvider??recovery.settings.telemetry.source}</Grid>
          <Grid size={{xs:6,md:3}}>Provider state: {
            recovery.runtime.telemetryConnectionState??'disconnected'}</Grid>
          <Grid size={{xs:6,md:3}}>Telemetry age: {
            recovery.runtime.telemetryAgeMs?.toFixed(0)??'—'} ms</Grid>
          <Grid size={{xs:6,md:3}}>Available modes: {
            recovery.runtime.availableDrivingModes?.join(', ')??'—'}</Grid>
          <Grid size={{xs:6,md:3}}>Backward confirmation: {
            recovery.runtime.backwardConfirmationState??'unavailable'}</Grid>
          <Grid size={{xs:12,md:6}}>Recovery Order: {
            recovery.runtime.recoveryOrderId??'—'}</Grid>
          <Grid size={{xs:12,md:6}}>Result: {
            recovery.runtime.recoveryResult??'—'}</Grid>
          <Grid size={{xs:12,md:6}}>Global replan: {
            recovery.runtime.globalReplanResult??'—'}</Grid>
        </Grid>
        {recovery.runtime.lastError&&<Alert severity="error" sx={{mt:1}}>
          {recovery.runtime.lastError}
        </Alert>}
        <Paper variant="outlined" sx={{p:1,mt:1,maxHeight:140,overflow:'auto'}}>
          {recovery.logs.slice(-40).map((entry)=><Typography key={entry.id}
            variant="caption" component="div"
            color={entry.level==='error'?'error.main':
              entry.level==='warning'?'warning.main':'text.secondary'}>
            {entry.timestamp} [RecoveryManager] {entry.message}
            {entry.context&&<span> {JSON.stringify(entry.context)}</span>}
          </Typography>)}
        </Paper>
      </Paper>
      <Paper variant="outlined" sx={{p:1.5,mt:2}}>
        <Typography variant="overline">Current replanning cycle</Typography>
        <Grid container spacing={1}>
          <Grid size={{xs:6,md:3}}>Attempt: {runtime.attempt}</Grid>
          <Grid size={{xs:6,md:3}}>Retry: {runtime.retryCount}/{settings.maximumRetries}</Grid>
          <Grid size={{xs:6,md:3}}>Obstacles: {runtime.temporaryObstacleCount}</Grid>
          <Grid size={{xs:6,md:3}}>Planning: {runtime.planningTimeMs?.toFixed(1)??'—'} ms</Grid>
          <Grid size={{xs:6,md:3}}>Original: {runtime.originalPathLengthM?.toFixed(2)??'—'} m</Grid>
          <Grid size={{xs:6,md:3}}>New: {runtime.newPathLengthM?.toFixed(2)??'—'} m</Grid>
          <Grid size={{xs:6,md:3}}>Route change: {
            runtime.maximumRouteDeviationM?.toFixed(2)??'—'} m</Grid>
          <Grid size={{xs:6,md:3}}>New nodes: {runtime.replacementOrder?.nodes.length??0}</Grid>
          <Grid size={{xs:6,md:3}}>New order: {runtime.replacementOrder?.orderId??'—'}</Grid>
          <Grid size={{xs:6,md:3}}>Explored cells: {runtime.exploredCells.length}</Grid>
        </Grid>
        <Typography variant="overline" sx={{display:'block',mt:1}}>Start projection</Typography>
        <Grid container spacing={1}>
          <Grid size={{xs:6,md:3}}>Original: {runtime.startProjection
            ?`${runtime.startProjection.originalPose.x.toFixed(3)}, ${
              runtime.startProjection.originalPose.y.toFixed(3)}`:'—'}</Grid>
          <Grid size={{xs:6,md:3}}>Projected: {runtime.startProjection?.projectedPose
            ?`${runtime.startProjection.projectedPose.x.toFixed(3)}, ${
              runtime.startProjection.projectedPose.y.toFixed(3)}`:'—'}</Grid>
          <Grid size={{xs:6,md:3}}>Distance: {runtime.startProjection?.projectionDistanceM
            ?.toFixed(3)??'—'} m</Grid>
          <Grid size={{xs:6,md:3}}>Success: {
            runtime.startProjection?.success===undefined?'—':
              runtime.startProjection.success?'Yes':'No'}</Grid>
          <Grid size={{xs:6,md:3}}>Projection waypoint used: {
            runtime.startProjection?.usedProjectedStartWaypoint===undefined?'—':
              runtime.startProjection.usedProjectedStartWaypoint?'Yes':'No'}</Grid>
        </Grid>
        {runtime.startProjection?.failureReason&&<Alert severity="error" sx={{mt:1}}>
          {runtime.startProjection.failureReason}
        </Alert>}
        <Typography variant="overline" sx={{display:'block',mt:1}}>Obstacle ingestion</Typography>
        <Stack gap={.5}>{runtime.obstacleIngestionDiagnostics.map((diagnostic,index)=>
          <Typography key={`${diagnostic.sourceTopic}-${index}`} variant="caption">
            {diagnostic.sourceTopic}: raw {diagnostic.rawPointCount}, transformed {
              diagnostic.transformedPointCount}, rejected {diagnostic.rejectedPointCount},
            clusters {diagnostic.obstacleClusterCount}, occupied {
              diagnostic.insertedOccupiedCells}, inflated {diagnostic.inflatedCells}
          </Typography>)}</Stack>
        {runtime.lastError&&<Alert severity="error" sx={{mt:1}}>{runtime.lastError}</Alert>}
      </Paper>
      <Paper variant="outlined" sx={{p:1,mt:2,maxHeight:220,overflow:'auto'}}>
        <Typography variant="overline">Replanning log</Typography>
        <Stack gap={.5}>{store.logs.slice(-100).map((entry)=>
          <Typography key={entry.id} variant="caption" component="div"
            color={entry.level==='error'?'error.main':entry.level==='warning'?'warning.main':'text.secondary'}>
            {entry.timestamp} [{entry.source}] {entry.message}
            {entry.context&&<Typography component="span" variant="caption"
              sx={{display:'block',opacity:.75,overflowWrap:'anywhere'}}>
              {JSON.stringify(entry.context)}
            </Typography>}
          </Typography>)}</Stack>
      </Paper>
    </DialogContent>
    <DialogActions>
      <Button onClick={store.clearLogs}>Clear logs</Button>
      <Button onClick={recovery.clearLogs}>Clear recovery logs</Button>
      <Button onClick={recovery.resetRuntime}>Reset recovery</Button>
      <Button onClick={store.resetRuntime}>Reset runtime</Button>
      <Button onClick={onClose}>Close</Button>
    </DialogActions>
  </Dialog>;
};
