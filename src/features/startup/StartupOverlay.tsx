import { CheckCircle, ErrorOutline, Refresh, SettingsEthernet } from '@mui/icons-material';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogContent, LinearProgress, Stack,
  Typography,
} from '@mui/material';
import { MedRobotsLogo } from '../../app/MedRobotsLogo';
import { useAppStore } from '../../stores/appStore';
import { useLocatorStore } from '../locator/stores/locatorStore';
import { useStartupStore } from './startupStore';

export function StartupOverlay(){
  const startup=useStartupStore();
  const mqtt=useAppStore(state=>state.mqttConnected);
  const grid=useAppStore(state=>state.grid);
  const mapId=useAppStore(state=>state.activeNavigatorMapId);
  const robot=useAppStore(state=>state.state?.agvPosition?.positionInitialized===true&&
    state.connection?.connectionState?.toUpperCase()==='ONLINE');
  const locator=useLocatorStore(state=>state.sessionState==='logged-in');
  const steps=[
    ['Configuration',startup.phase!=='INITIALIZING'&&startup.phase!=='LOADING_CONFIGURATION'],
    ['MQTT',mqtt],['ROKIT Locator',locator],['Map',Boolean(grid&&mapId===grid.metadata.mapId)],['Robot state',mqtt&&robot],
  ] as const;
  const terminal=startup.phase==='READY'||startup.phase==='DEGRADED'||startup.phase==='ERROR';
  if(startup.dismissed||startup.phase==='READY')return null;
  return <Dialog open fullWidth maxWidth="sm" aria-labelledby="startup-title">
    <DialogContent sx={{p:4}}>
      <Stack alignItems="center" textAlign="center" gap={2.2}>
        <MedRobotsLogo/>
        <Box><Typography id="startup-title" variant="h1">Med Robots Navigation Control</Typography>
          <Typography color="text.secondary">PharmaRobot Autonomous Navigation</Typography></Box>
        {startup.running?<CircularProgress size={38}/>:startup.phase==='DEGRADED'
          ?<ErrorOutline color="warning" sx={{fontSize:42}}/>:<SettingsEthernet color="error" sx={{fontSize:42}}/>}
        <Box width="100%"><Typography fontWeight={700}>{startup.message}</Typography>
          <Typography variant="caption" color="text.secondary">{startup.phase.replaceAll('_',' ')}
            {startup.retryAttempt?` · retry ${startup.retryAttempt}`:''}</Typography></Box>
        {startup.running&&<LinearProgress sx={{width:'100%',borderRadius:2}}/>}
        <Stack direction="row" justifyContent="space-between" width="100%">
          {steps.map(([label,complete])=><Stack key={label} alignItems="center" gap={.4}
            aria-label={`${label} ${complete?'ready':'pending'}`}>
            <CheckCircle color={complete?'success':'disabled'} fontSize="small"/>
            <Typography variant="caption">{label}</Typography>
          </Stack>)}
        </Stack>
        {startup.error&&<Alert severity={startup.phase==='DEGRADED'?'warning':'error'}
          sx={{width:'100%',whiteSpace:'pre-line',textAlign:'left'}}>{startup.error}</Alert>}
        {terminal&&<Stack direction="row" gap={1}>
          <Button startIcon={<Refresh/>} variant="contained" onClick={startup.retry}>Retry startup</Button>
          <Button onClick={startup.dismiss}>Continue in advanced mode</Button>
        </Stack>}
      </Stack>
    </DialogContent>
  </Dialog>;
}
