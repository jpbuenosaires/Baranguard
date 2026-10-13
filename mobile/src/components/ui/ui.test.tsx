import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Banner, Button, Card, Chip, EmptyState, ErrorState, SyncLabel } from './index';
import { SyncChip, Banner as WfBanner } from '../WorkflowBits';

describe('Button', () => {
  it('is a real button with a name and fires on click and keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toHaveProperty('type', 'button');
    await userEvent.click(btn);
    btn.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('keeps its label when disabled and does not fire', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Send report</Button>);
    const btn = screen.getByRole('button', { name: 'Send report' });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading keeps the label, sets aria-busy and blocks clicks', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Submit</Button>);
    const btn = screen.getByRole('button', { name: 'Submit' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies variant, size and fullWidth classes', () => {
    render(<Button variant="danger" size="lg" fullWidth>Delete</Button>);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toContain('ui-btn--danger');
    expect(btn.className).toContain('ui-btn--lg');
    expect(btn.className).toContain('ui-btn--full');
  });
});

describe('Card', () => {
  it('renders title, subtitle and action', () => {
    render(<Card title="Shift" subtitle="Today" action={<button>Edit</button>}>Body</Card>);
    expect(screen.getByRole('heading', { name: 'Shift' })).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
  });
});

describe('Chip', () => {
  it('is a span without onClick', () => {
    render(<Chip tone="success">Active</Chip>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Active').closest('span.ui-chip')).toBeTruthy();
  });

  it('is a toggle button with onClick and reflects selected', async () => {
    const onClick = vi.fn();
    render(<Chip onClick={onClick} selected>Open</Chip>);
    const btn = screen.getByRole('button', { name: 'Open' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Banner', () => {
  it('uses role alert for error and status otherwise', () => {
    const { rerender } = render(<Banner tone="error">Failed</Banner>);
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    for (const tone of ['info', 'success', 'warning'] as const) {
      rerender(<Banner tone={tone}>Msg</Banner>);
      expect(screen.getByRole('status')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    }
  });

  it('dismiss button has an accessible label and calls back', async () => {
    const onDismiss = vi.fn();
    render(<Banner onDismiss={onDismiss} dismissLabel="Dismiss notice">Hi</Banner>);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders an optional action', () => {
    render(<Banner action={<button>Retry now</button>}>Hi</Banner>);
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeTruthy();
  });
});

describe('EmptyState and ErrorState', () => {
  it('EmptyState shows title, body and action', () => {
    render(<EmptyState title="Nothing yet" body="Check back later" action={<button>Refresh</button>} />);
    expect(screen.getByText('Nothing yet')).toBeTruthy();
    expect(screen.getByText('Check back later')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('ErrorState announces the message and always offers retry', async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Could not load" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ErrorState honours a custom retry label', () => {
    render(<ErrorState message="x" onRetry={() => {}} retryLabel="Reload" />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});

describe('SyncLabel', () => {
  const cases: Array<[Parameters<typeof SyncLabel>[0]['state'], string]> = [
    ['saved_on_phone', 'Saved on phone'],
    ['sending', 'Sending'],
    ['sent', 'Sent'],
    ['failed', 'Not sent, will retry'],
    ['waiting_connection', 'Waiting for connection'],
  ];
  it.each(cases)('%s shows "%s" with role status', (state, text) => {
    render(<SyncLabel state={state} />);
    expect(screen.getByRole('status').textContent).toBe(text);
  });

  it('failed without auto-retry reads Needs attention', () => {
    render(<SyncLabel state="failed" willRetry={false} />);
    expect(screen.getByRole('status').textContent).toBe('Needs attention');
  });
});

describe('WorkflowBits delegation', () => {
  it('SyncChip words rows through SyncLabel', () => {
    const { rerender } = render(<SyncChip row={{ synced: 0, permanent_failure: 0 }} />);
    expect(screen.getByRole('status').textContent).toBe('Saved on phone');
    rerender(<SyncChip row={{ synced: 1, permanent_failure: 0 }} />);
    expect(screen.getByRole('status').textContent).toBe('Sent');
    rerender(<SyncChip row={{ synced: 0, permanent_failure: 1 }} />);
    expect(screen.getByRole('status').textContent).toBe('Needs attention');
  });

  it('legacy Banner keeps its roles', () => {
    const { rerender } = render(<WfBanner tone="critical">Bad</WfBanner>);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<WfBanner tone="success">Ok</WfBanner>);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
