import { describe, it, expect } from 'vitest';
import { computeTrend } from '../trend';

describe('computeTrend', () => {
  it('null/zero baseline → flat, neutral, null deltaPct', () => {
    expect(computeTrend(10, null)).toMatchObject({ deltaPct: null, direction: 'flat', polarity: 'neutral', significant: false });
    expect(computeTrend(10, 0)).toMatchObject({ deltaPct: null, direction: 'flat', polarity: 'neutral' });
    expect(computeTrend(null, 10)).toMatchObject({ deltaPct: null, direction: 'flat' });
  });
  it('below the significance threshold → neutral (no good/bad)', () => {
    expect(computeTrend(103, 100)).toMatchObject({ direction: 'up', significant: false, polarity: 'neutral' });
  });
  it('significant increase, higher-is-better → good', () => {
    expect(computeTrend(150, 100)).toMatchObject({ deltaPct: 50, direction: 'up', significant: true, polarity: 'good' });
  });
  it('significant increase, lowerIsBetter → bad', () => {
    expect(computeTrend(150, 100, { lowerIsBetter: true })).toMatchObject({ direction: 'up', polarity: 'bad' });
  });
  it('significant decrease, lowerIsBetter → good', () => {
    expect(computeTrend(50, 100, { lowerIsBetter: true })).toMatchObject({ deltaPct: -50, direction: 'down', polarity: 'good' });
  });
  it('exact equal → flat, neutral', () => {
    expect(computeTrend(100, 100)).toMatchObject({ deltaPct: 0, direction: 'flat', significant: false, polarity: 'neutral' });
  });
  it('honors a custom significance floor', () => {
    expect(computeTrend(103, 100, { minPctForSignificance: 2 })).toMatchObject({ significant: true, polarity: 'good' });
  });
});
