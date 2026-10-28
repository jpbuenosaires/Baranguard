import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const getMyShifts = vi.fn();
const getMyShiftSwapRequests = vi.fn();
const loadShiftCache = vi.fn();

vi.mock('../services/apiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/apiService')>();
  return {
    ...actual,
    getMyShifts: (...a: unknown[]) => getMyShifts(...a),
    getMyShiftSwapRequests: (...a: unknown[]) => getMyShiftSwapRequests(...a),
  };
});
vi.mock('../services/shiftCache', () => ({
  loadShiftCache: (...a: unknown[]) => loadShiftCache(...a),
  saveShiftCache: vi.fn(),
}));
vi.mock('../components/MobileHeader', () => ({ default: () => <div /> }));

import MyShiftsPage from './my-shifts';

describe('My shifts load failure', () => {
  beforeEach(() => {
    getMyShifts.mockReset();
    getMyShiftSwapRequests.mockReset();
    loadShiftCache.mockReset();
    loadShiftCache.mockResolvedValue(null);
  });

  it('shows an error with a Retry that reloads and then shows the empty state', async () => {
    getMyShifts.mockRejectedValueOnce(new Error('boom'));
    getMyShiftSwapRequests.mockResolvedValue([]);
    getMyShifts.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <MyShiftsPage />
      </MemoryRouter>
    );
    expect(await screen.findByText('Could not load your duty schedule.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('No upcoming shifts')).toBeTruthy();
    expect(getMyShifts).toHaveBeenCalledTimes(2);
  });

  it('falls back to the saved copy when the workstation is unreachable', async () => {
    const shift = { shiftId: 7, patrolZone: 'Zone Cached', startAt: '2099-01-01T00:00:00Z', endAt: '2099-01-01T08:00:00Z', version: 1, approvalStatus: 'published', pendingReapproval: false };
    loadShiftCache.mockResolvedValue({ shifts: [shift], swapRequests: [], savedAt: '2026-10-28T00:00:00Z' });
    getMyShifts.mockRejectedValue(new Error('offline'));
    getMyShiftSwapRequests.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <MyShiftsPage />
      </MemoryRouter>
    );
    expect(await screen.findByText(/Showing your saved schedule/)).toBeTruthy();
    expect(screen.queryByText('Could not load your duty schedule.')).toBeNull();
  });
});
