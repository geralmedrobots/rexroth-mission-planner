import { Box, Typography } from '@mui/material';
import { useState } from 'react';
import logoUrl from '../assets/logo_medrobots.png';

/** Official brand asset at src/assets/logo_medrobots.png. */
export function MedRobotsLogo({compact=false}:{compact?:boolean}) {
  const [failed,setFailed]=useState(false);
  if(failed)return <Box aria-label="Med Robots logo placeholder" sx={{
    width:compact?82:140,height:compact?28:46,border:'1px dashed',borderColor:'divider',borderRadius:1,
    display:'grid',placeItems:'center',
  }}><Typography variant="caption">Med Robots</Typography></Box>;
  return <Box component="img" src={logoUrl} alt="Med Robots" onError={()=>setFailed(true)}
    sx={{display:'block',width:compact?82:140,height:compact?28:46,objectFit:'contain'}}/>;
}
