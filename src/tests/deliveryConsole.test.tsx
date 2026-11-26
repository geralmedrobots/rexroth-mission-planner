import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeliveryConsole } from '../features/pharmacy/DeliveryConsole';
import { deliveryRequest } from '../features/pharmacy/deliveryApi';
import type { DeliveryView } from '../features/pharmacy/model';
vi.mock('../features/pharmacy/deliveryApi', () => ({ deliveryRequest: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('recovers the checkpoint after remount, preserves Not yet and posts the exact run revision', async () => {
  const view: DeliveryView = {
    archive: [],
    maps: [],
    connected: true,
    localisation: 'Initialized',
    run: {
      id: 'delivery',
      revision: 4,
      index: 2,
      started: Date.now(),
      phase: 'WAITING_FOR_MEDICINE_LOADING',
      events: [],
    },
  };
  vi.mocked(deliveryRequest).mockResolvedValue(view);
  const first = render(<DeliveryConsole open={false} onClose={() => {}} />);
  expect(await screen.findByText('Has the medicine been placed inside the robot?')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Not yet.' }));
  expect(vi.mocked(deliveryRequest).mock.calls.filter(([op]) => op)).toHaveLength(0);
  first.unmount();
  render(<DeliveryConsole open={false} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Yes, medicine loaded.' }));
  await waitFor(() =>
    expect(deliveryRequest).toHaveBeenCalledWith('confirm', { id: 'delivery', revision: 4 }),
  );
});
