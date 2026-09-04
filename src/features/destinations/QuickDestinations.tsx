import {
  AddLocationAlt, BatteryChargingFull, Biotech, Home, LocalHospital, LocalPharmacy,
  MoveToInbox, Science,
} from '@mui/icons-material';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import type { RobotPose } from '../../domain/types';
import type { DestinationCategory, SavedDestination } from './destinationStore';
import { useDestinationStore } from './destinationStore';

const icons:Record<DestinationCategory,React.ReactNode>={
  pharmacy:<LocalPharmacy/>,laboratory:<Science/>,reception:<LocalHospital/>,ward:<LocalHospital/>,
  charging:<BatteryChargingFull/>,delivery:<MoveToInbox/>,home:<Home/>,other:<Biotech/>,
};
export function QuickDestinations({
  mapId,onSelect,currentGoal,onSaveGoal,
}:{mapId:string|null;onSelect:(destination:SavedDestination)=>void;currentGoal?:RobotPose;onSaveGoal?:()=>void}){
  const destinations=useDestinationStore((state)=>state.destinations)
    .filter((item)=>item.enabled&&item.mapId===mapId);
  return <Paper className="mr-glass" sx={{p:1.5}}>
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Box><Typography variant="overline">Quick destinations</Typography>
        <Typography variant="caption" color="text.secondary" display="block">Hospital locations on this map</Typography></Box>
      <Button size="small" startIcon={<AddLocationAlt/>} disabled={!currentGoal} onClick={onSaveGoal}>Save point</Button>
    </Stack>
    {destinations.length===0?<Alert severity="info" sx={{mt:1}}>No destinations saved for this map. Select a point and save it.</Alert>:
      <Box sx={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:1,mt:1}}>
        {destinations.map((destination)=><Button key={destination.id} variant="outlined"
          startIcon={icons[destination.category]} onClick={()=>onSelect(destination)}
          sx={{justifyContent:'flex-start',minHeight:48}}>{destination.displayName}</Button>)}
      </Box>}
  </Paper>;
}
