import { Alert, Paper, Stack, Typography } from '@mui/material';
import { useLocatorStore } from '../stores/locatorStore';
import { compareMapIds } from '../../../domain/robot/ActiveMapResolver';
import { LocatorMapDiagnostics } from './LocatorMapDiagnostics';

const Datum = ({ label, value }: { label: string; value: unknown }) =>
  <Stack direction="row" justifyContent="space-between" gap={1}>
    <Typography variant="caption" color="text.secondary">{label}</Typography>
    <Typography variant="caption" fontFamily="monospace">{value === undefined || value === '' ? 'N/A' : String(value)}</Typography>
  </Stack>;

export function LocatorMapStatus() {
  const store = useLocatorStore();
  const map = store.loadedMap;
  const comparison=compareMapIds(map?.mapName,store.activeNavigatorMapId);
  const mismatch = Boolean(store.activeNavigatorMapId && map && !comparison.matches);
  return <Paper variant="outlined" sx={{ p: 1.5 }}>
    <Typography variant="subtitle2">Locator Map Status</Typography>
    <Datum label="RPC state" value={store.connectionState}/>
    <Datum label="Session" value={store.sessionState}/>
    <Datum label="ServerMap module" value={store.testResult?.serverMapModule
      ? `${store.testResult.serverMapModule.majorVersion}.${store.testResult.serverMapModule.minorVersion}` : undefined}/>
    <Datum label="Active Navigator mapId" value={store.activeNavigatorMapId}/>
    <Datum label="Loaded Locator map" value={map?.mapName}/>
    <Datum label="Image pixels" value={map ? `${map.pixelWidth} × ${map.pixelHeight}` : undefined}/>
    <Datum label="Map meters" value={map ? `${map.widthMeters} × ${map.heightMeters}` : undefined}/>
    <Datum label="Origin x / y / yaw" value={map
      ? `${map.origin.x.toFixed(3)} / ${map.origin.y.toFixed(3)} / ${map.origin.yaw.toFixed(3)}` : undefined}/>
    <Datum label="Resolution" value={map ? `${map.pixelsPerMeter} px/m (${map.metersPerPixel} m/px)` : undefined}/>
    <Datum label="Last download" value={store.lastDownloadTime}/>
    <LocatorMapDiagnostics/>
    {mismatch && <Alert severity="error" sx={{ mt: 1 }}>Active Navigator mapId and loaded Locator map differ. Order publication must remain disabled.</Alert>}
  </Paper>;
}
