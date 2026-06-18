import { describe, it, expect } from 'vitest';
import { liveness } from '../shell/liveness';

describe('liveness() — single source of truth for 3-state indicator', () => {
  it('disconnected → down / reconnecting', () => {
    const l = liveness(false, false);
    expect(l.cls).toBe('down');
    expect(l.label).toBe('○ reconnecting');
    expect(l.title).toBe('reconnecting');
  });

  it('connected but stale → stale', () => {
    const l = liveness(true, true);
    expect(l.cls).toBe('stale');
    expect(l.label).toBe('◐ stale');
    expect(l.title).toBe('connected, but no fresh data in 90s — feed may be stalled');
  });

  it('connected and fresh → live', () => {
    const l = liveness(true, false);
    expect(l.cls).toBe('live');
    expect(l.label).toBe('● live');
    expect(l.title).toBe('live');
  });

  it('disconnected while stale → still down (disconnected wins)', () => {
    const l = liveness(false, true);
    expect(l.cls).toBe('down');
    expect(l.label).toBe('○ reconnecting');
  });
});
