import { CssBaseline, ThemeProvider } from '@mui/material';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { medRobotsTheme } from './app/theme';
import './app/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider theme={medRobotsTheme}><CssBaseline/><App/></ThemeProvider></StrictMode>,
);
