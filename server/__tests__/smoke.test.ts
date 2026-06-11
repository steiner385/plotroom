import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});

// Config guard: this file must always run in the node environment (no jsdom).
describe('env-probe', () => {
  it('runs in node environment (no DOM)', () => {
    expect(typeof document).toBe('undefined');
  });
});
