import { createTheme } from '@mui/material';

const medRobotsRed='#c8102e';
const medRobotsDarkRed='#8f0b22';

export const medRobotsTheme=createTheme({
  palette:{
    mode:'light',
    primary:{main:medRobotsRed,contrastText:'#ffffff'},
    secondary:{main:medRobotsDarkRed,contrastText:'#ffffff'},
    success:{main:'#176747'},
    warning:{main:'#b56a00'},
    error:{main:'#c8102e'},
    background:{default:'#f4f5f7',paper:'#ffffff'},
    text:{primary:'#24282d',secondary:'#687078'},
    divider:'#d5dce1',
  },
  typography:{
    fontFamily:'Inter, "Segoe UI Variable", "Segoe UI", sans-serif',
    h1:{fontSize:'1.55rem',fontWeight:750,letterSpacing:'-.03em'},
    h2:{fontSize:'1.2rem',fontWeight:700,letterSpacing:'-.02em'},
    h3:{fontSize:'1rem',fontWeight:700},
    button:{fontWeight:700,textTransform:'none',letterSpacing:'.01em'},
    overline:{fontWeight:750,letterSpacing:'.12em',fontSize:'.7rem',color:'#52616b'},
  },
  shape:{borderRadius:8},
  components:{
    MuiCssBaseline:{styleOverrides:{
      body:{scrollbarColor:'#c8cdd2 #f4f5f7'},
      '*':{boxSizing:'border-box'},
      '*:focus-visible':{outline:`2px solid ${medRobotsRed}`,outlineOffset:2},
    }},
    MuiPaper:{styleOverrides:{root:{
      backgroundImage:'none',
      borderColor:'#d5dce1',
    }}},
    MuiButton:{
      defaultProps:{size:'medium'},
      styleOverrides:{root:{borderRadius:6,minHeight:34}},
    },
    MuiChip:{styleOverrides:{root:{fontWeight:700,borderRadius:5}}},
    MuiDialog:{styleOverrides:{paper:{
      background:'#fff',
      border:'1px solid #d5dce1',
      boxShadow:'0 16px 52px rgba(32,46,56,.18)',
    }}},
    MuiAppBar:{styleOverrides:{root:{color:'#ffffff'}}},
    MuiTooltip:{defaultProps:{arrow:true}},
  },
});
