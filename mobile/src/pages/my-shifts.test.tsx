import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const getMyShifts = vi.fn();
const getMyShiftSwapRequests = vi.fn();

vi.mock('../services/apiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/apiService')>();
  return {
    ...actual,
    getMyShifts: (...a: unknown[]) => getMyShifts(...a),
    getMyShiftSwapRequests: (...a: unknown[]) => getMyShiftSwapRequests(...a),
  };
});
vi.mock('../components/MobileHeader', () => ({ default: () => <div /> }));

import MyShiftsPage from './my-shifts';

describe('My shifts load failure', () => {
  beforeEach(() => {
    getMyShifts.mockReset();
    getMyShiftSwapRequests.mockReset();
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
});
