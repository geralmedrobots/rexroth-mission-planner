import { CssBaseline, ThemeProvider } from '@mui/material';
import App from '../App';
import { createMedRobotsTheme } from './theme';
import { useOperatorSettingsStore } from '../features/settings/operatorSettingsStore';

export function ThemedApplication(){
  const themeMode=useOperatorSettingsStore((state)=>state.settings.themeMode);
  return <ThemeProvider theme={createMedRobotsTheme(themeMode)}>
    <CssBaseline/><App/>
  </ThemeProvider>;
}
