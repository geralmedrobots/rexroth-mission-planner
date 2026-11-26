import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemedApplication } from './app/ThemedApplication';
import './app/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemedApplication/></StrictMode>,
);
