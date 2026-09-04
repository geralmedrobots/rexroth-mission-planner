import { CheckCircle, ErrorOutline, Refresh, SettingsEthernet } from '@mui/icons-material';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogContent, LinearProgress, Stack,
  Typography,
} from '@mui/material';
import { MedRobotsLogo } from '../../app/MedRobotsLogo';
import { useStartupStore } from './startupStore';

const labels=['Configuration','MQTT','ROKIT Locator','Map','Robot state'];
export function StartupOverlay(){
  const startup=useStartupStore();
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
          {labels.map((label,index)=><Stack key={label} alignItems="center" gap={.4}>
            <CheckCircle color={index<(startup.phase==='CONNECTING_MQTT'?1:startup.phase==='CONNECTING_LOCATOR'?2:
              startup.phase==='LOADING_MAPS'?3:startup.phase==='WAITING_FOR_ROBOT'?4:0)?'success':'disabled'} fontSize="small"/>
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
