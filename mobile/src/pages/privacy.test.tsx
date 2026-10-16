import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../components/MobileHeader', () => ({ default: () => <div /> }));

import PrivacyPage from './privacy';

describe('Privacy notice page', () => {
  it('shows the draft marking, headings and the full-notice button', () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1, name: /privacy notice/i })).toBeTruthy();
    expect(screen.getByText('Draft.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /read the full notice/i })).toBeTruthy();
  });
});
