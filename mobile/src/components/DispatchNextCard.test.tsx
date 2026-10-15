import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DispatchNextCard from './DispatchNextCard';
import CollapsibleSection from './CollapsibleSection';

const base = {
  next: 'arrived',
  incidentCode: 'INC-2026-004',
  incidentType: 'noise_complaint',
  priority: 'high',
  statusLabel: 'En Route',
  locationLine: 'Purok 2',
  telemetry: '300 m away, bearing N',
  age: '5 min ago',
  synced: true,
  serverDispatchId: 12,
  updating: false,
  onAdvance: () => undefined,
};

describe('DispatchNextCard', () => {
  it('shows the code and one status action that fires', async () => {
    const onAdvance = vi.fn();
    render(<DispatchNextCard {...base} onAdvance={onAdvance} />);
    expect(screen.getByText('INC-2026-004')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mark arrived' }));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('says the change is only saved on the phone while unsynced', () => {
    render(<DispatchNextCard {...base} synced={false} />);
    expect(screen.getByText(/Saved on phone/)).toBeTruthy();
    expect(screen.queryByText('Sent')).toBeNull();
  });

  it('disables the action and says why when there is no server id', () => {
    render(<DispatchNextCard {...base} serverDispatchId={null} />);
    expect(screen.getByRole('button', { name: 'Mark arrived' })).toBeDisabled();
    expect(screen.getByText(/Connect to the workstation/)).toBeTruthy();
  });

  it('has no action once there is no next status', () => {
    render(<DispatchNextCard {...base} next={null} statusLabel="Completed" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('CollapsibleSection', () => {
  it('keeps its body mounted while collapsed and toggles aria-expanded', async () => {
    render(<CollapsibleSection title="Evidence"><input aria-label="note" /></CollapsibleSection>);
    const head = screen.getByRole('button', { name: /Evidence/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('input')).not.toBeNull();
    await userEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
});
