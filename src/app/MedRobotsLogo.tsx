import { Box, Typography } from '@mui/material';
import { useState } from 'react';
import logoUrl from '../assets/logo_medrobots.png';

/** Official asset location: src/assets/logo_medrobots.png. Replace that file to update branding. */
export function MedRobotsLogo({compact=false}:{compact?:boolean}) {
  const [failed,setFailed]=useState(false);
  if(failed)return <Box aria-label="Med Robots logo placeholder" sx={{
    width:compact?42:112,height:34,border:'1px dashed',borderColor:'divider',borderRadius:1,
    display:'grid',placeItems:'center',
  }}><Typography variant="caption">Med Robots</Typography></Box>;
  return <Box component="img" src={logoUrl} alt="Med Robots" onError={()=>setFailed(true)}
    sx={{display:'block',width:compact?42:112,height:compact?24:42,objectFit:'contain'}}/>;
}
