import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { locatorMapService } from '../features/locator/services/locatorMapService';
import { locatorSessionService } from '../features/locator/services/locatorSessionService';
import { StartupOverlay } from '../features/startup/StartupOverlay';
import { useStartupStore } from '../features/startup/startupStore';
import { useStartupConnections } from '../features/startup/useStartupConnections';
import { mqttService } from '../services/MqttService';
import { useAppStore } from '../stores/appStore';

beforeEach(()=>{
  useAppStore.setState(useAppStore.getInitialState(),true);
  useLocatorStore.setState(useLocatorStore.getInitialState(),true);
  useStartupStore.setState(useStartupStore.getInitialState(),true);
});
afterEach(()=>{
  cleanup();
  vi.restoreAllMocks();
});

it('shows a failed Locator connection and uses actual readiness for startup steps',async()=>{
  vi.spyOn(mqttService,'connect').mockImplementation(()=>{});
  vi.spyOn(locatorSessionService,'connect').mockRejectedValue(new Error('Fixture bridge unavailable'));
  vi.spyOn(locatorSessionService,'test').mockRejectedValue(new Error('Fixture bridge unavailable'));
  vi.spyOn(locatorSessionService,'automaticLogin').mockRejectedValue(new Error('Fixture bridge unavailable'));
  vi.spyOn(locatorMapService,'listMaps').mockRejectedValue(new Error('Fixture bridge unavailable'));
  function Startup() {
    useStartupConnections(()=>{});
    return <StartupOverlay/>;
  }
  render(<Startup/>);
  await act(async()=>{});
  expect(useLocatorStore.getState().connectionState).toBe('error');
  expect(useLocatorStore.getState().error).toBe('Fixture bridge unavailable');
  expect(screen.getByLabelText('MQTT pending')).toBeVisible();
  expect(screen.getByLabelText('ROKIT Locator pending')).toBeVisible();
  act(()=>useAppStore.getState().set({mqttConnected:true}));
  expect(screen.getByLabelText('MQTT ready')).toBeVisible();
});
