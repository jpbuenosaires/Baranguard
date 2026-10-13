// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TextField } from './FormFields';

describe('TextField accessibility props', () => {
  it('passes input attributes through and links the error message', () => {
    const { container } = render(
      <TextField
        label="Username"
        value=""
        onChange={() => {}}
        inputMode="numeric"
        autoComplete="username"
        enterKeyHint="next"
        autoCorrect="off"
        required
        error="Enter your username"
      />
    );
    const ion = container.querySelector('ion-input') as HTMLElement;
    expect(ion).not.toBeNull();
    expect(ion.getAttribute('aria-invalid')).toBe('true');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Enter your username');
    expect(ion.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('has no error markup when valid', () => {
    const { container } = render(<TextField label="Password" value="x" onChange={() => {}} />);
    const ion = container.querySelector('ion-input') as HTMLElement;
    expect(ion.getAttribute('aria-invalid')).toBeNull();
    expect(ion.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
