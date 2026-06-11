import { describe, it, expect } from 'vitest';

// Config guard: this file must always run in the jsdom environment.
// If this assertion fails, the vitest projects config has regressed.
describe('env-probe', () => {
  it('runs in jsdom environment (document exists)', () => {
    expect(typeof document).not.toBe('undefined');
  });
});
