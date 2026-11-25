import {
  AddLocationAlt, BatteryChargingFull, Biotech, Home, LocalHospital, LocalPharmacy,
  MoveToInbox, Science,
} from '@mui/icons-material';
import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import type { RobotPose } from '../../domain/types';
import type { DestinationCategory, SavedDestination } from './destinationStore';
import { useDestinationStore } from './destinationStore';

const icons:Record<DestinationCategory,React.ReactNode>={
  pharmacy:<LocalPharmacy/>,laboratory:<Science/>,reception:<LocalHospital/>,ward:<LocalHospital/>,
  charging:<BatteryChargingFull/>,delivery:<MoveToInbox/>,home:<Home/>,other:<Biotech/>,
};
export function QuickDestinations({
  mapId,onSelect,currentGoal,onSaveGoal,onManage,
}:{mapId:string|null;onSelect:(destination:SavedDestination)=>void;currentGoal?:RobotPose;onSaveGoal?:()=>void;onManage:()=>void}){
  const destinations=useDestinationStore((state)=>state.destinations)
    .filter((item)=>item.enabled&&item.mapId===mapId).sort((a,b)=>a.displayName.localeCompare(b.displayName));
  return <Paper className="mr-glass" sx={{p:1.5}}>
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Box><Typography variant="overline">Quick destinations</Typography>
        <Typography variant="caption" color="text.secondary" display="block">Saved locations</Typography></Box>
      <Button size="small" startIcon={<AddLocationAlt/>} disabled={!currentGoal||!mapId} onClick={onSaveGoal}>Save point</Button>
    </Stack>
    <Button size="small" onClick={onManage}>Manage waypoints</Button>
    {destinations.length===0?<Typography variant="body2" color="text.secondary" sx={{mt:1}}>{mapId
      ?'No waypoints saved on this map.'
      :'Load a planning map to save waypoints.'}</Typography>:
      <Box sx={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:1,mt:1}}>
        {destinations.map((destination)=><Button key={destination.id} variant="outlined"
          startIcon={icons[destination.category]} onClick={()=>onSelect(destination)}
          sx={{justifyContent:'flex-start',minHeight:48}}>{destination.displayName}</Button>)}
      </Box>}
  </Paper>;
}
