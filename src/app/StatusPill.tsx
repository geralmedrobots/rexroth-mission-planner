import { Chip, type ChipProps } from '@mui/material';

type Tone='connected'|'warning'|'error'|'inactive'|'info';
const colors:Record<Tone,ChipProps['color']>={
  connected:'success',warning:'warning',error:'error',inactive:'default',info:'primary',
};
export function StatusPill({label,tone='inactive',pulse=false}:{label:string;tone?:Tone;pulse?:boolean}) {
  return <Chip size="small" variant={tone==='inactive'?'outlined':'filled'} color={colors[tone]}
    className={pulse?'mr-status-pulse':undefined}
    label={label} sx={pulse?{'& .MuiChip-label':{pl:.7},gap:.6}:undefined}/>;
}
