import { alpha, createTheme, type PaletteMode } from '@mui/material';

const medRobotsNavy='#07345f';
const medRobotsTeal='#079da5';

export const createMedRobotsTheme=(mode:PaletteMode='dark')=>createTheme({
  palette:{
    mode,
    primary:{main:mode==='dark'?'#007BFF':medRobotsNavy,contrastText:'#ffffff'},
    secondary:{main:mode==='dark'?'#00B8F0':medRobotsTeal,contrastText:'#ffffff'},
    success:{main:mode==='dark'?'#22C55E':'#16875f'},
    warning:{main:mode==='dark'?'#F59E0B':'#b56a00'},
    error:{main:mode==='dark'?'#EF4444':'#c43a43'},
    background:mode==='dark'
      ?{default:'#050D18',paper:'#0D1C2D'}
      :{default:'#f2f7fa',paper:'#ffffff'},
    text:mode==='dark'
      ?{primary:'#F1F5F9',secondary:'#94A3B8'}
      :{primary:'#14283b',secondary:'#607181'},
    divider:mode==='dark'?'#203D55':'rgba(7,52,95,.15)',
  },
  typography:{
    fontFamily:'Inter, "Segoe UI Variable", "Segoe UI", sans-serif',
    h1:{fontSize:'1.55rem',fontWeight:750,letterSpacing:'-.03em'},
    h2:{fontSize:'1.2rem',fontWeight:700,letterSpacing:'-.02em'},
    h3:{fontSize:'1rem',fontWeight:700},
    button:{fontWeight:700,textTransform:'none',letterSpacing:'.01em'},
    overline:{fontWeight:750,letterSpacing:'.12em',fontSize:'.7rem',
      color:mode==='dark'?'#94A3B8':medRobotsNavy},
  },
  shape:{borderRadius:14},
  components:{
    MuiCssBaseline:{styleOverrides:{
      body:{scrollbarColor:mode==='dark'?'#475569 #081524':'#c8cdd2 #f4f5f7'},
      '*':{boxSizing:'border-box'},
      '*:focus-visible':{outline:`2px solid ${medRobotsTeal}`,outlineOffset:2},
    }},
    MuiPaper:{styleOverrides:{root:{
      backgroundImage:'none',
      borderColor:mode==='dark'?'#203D55':'rgba(7,52,95,.15)',
    }}},
    MuiButton:{
      defaultProps:{size:'medium'},
      styleOverrides:{root:{borderRadius:10,minHeight:38}},
    },
    MuiChip:{styleOverrides:{root:{fontWeight:700,borderRadius:9}}},
    MuiDialog:{styleOverrides:{paper:{
      background:mode==='dark'
        ?'linear-gradient(155deg,#0D1C2D,#081524)'
        :'linear-gradient(155deg,#ffffff,#f4fbfc)',
      border:`1px solid ${alpha(mode==='dark'?'#203D55':medRobotsNavy,.9)}`,
      boxShadow:mode==='dark'
        ?'0 30px 90px rgba(0,0,0,.48)'
        :'0 30px 90px rgba(7,52,95,.18)',
    }}},
    MuiAppBar:{styleOverrides:{root:{color:mode==='dark'?'#F1F5F9':'#ffffff'}}},
    MuiTooltip:{defaultProps:{arrow:true}},
  },
});

export const medRobotsTheme=createMedRobotsTheme('dark');
