import { describe, expect, it } from 'vitest';
import { shouldDismissOnDrag, sosResultHeadline } from './sosSheet';

describe('sosSheet', () => {
  it('dismisses only past the threshold and not while sending', () => {
    expect(shouldDismissOnDrag(69, false)).toBe(false);
    expect(shouldDismissOnDrag(70, false)).toBe(true);
    expect(shouldDismissOnDrag(200, true)).toBe(false);
    expect(shouldDismissOnDrag(-80, false)).toBe(false);
  });
  it('words saved results as not yet sent', () => {
    expect(sosResultHeadline('sent')).toBe('SOS sent');
    expect(sosResultHeadline('saved')).toMatch(/saved on this phone/);
    expect(sosResultHeadline('saved')).not.toMatch(/^SOS sent/);
  });
});
