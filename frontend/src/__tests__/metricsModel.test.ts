import { describe, it, expect } from 'vitest';
import {
  windowBuckets, align, alignCounts, alignBand, deltaText, calibrationHeadline,
  fmtMinutes, fmtDollars, fmtPct, fmtCount, resolveRecLink, WINDOW_DAYS,
} from '../metricsModel';
import type { HeadlineStat } from '../types';

const stat = (value: number | null, prev: number | null): HeadlineStat =>
  ({ value, prev } as unknown as HeadlineStat);

describe('metricsModel — windowBuckets', () => {
  const now = new Date('2026-06-20T00:00:00Z');

  it('emits one day key per day, oldest first, ending today', () => {
    expect(windowBuckets('3d', 'day', now)).toEqual(['2026-06-18', '2026-06-19', '2026-06-20']);
  });

  it('emits days*24 hour keys for an hour bucket, ending on the current hour', () => {
    const keys = windowBuckets('24h', 'hour', now);
    expect(keys).toHaveLength(WINDOW_DAYS['24h'] * 24);
    expect(keys[keys.length - 1]).toBe('2026-06-20T00');
    expect(keys[0]).toBe('2026-06-19T01');
  });
});

describe('metricsModel — alignment helpers', () => {
  const axis = ['a', 'b', 'c'];

  it('align leaves missing buckets as null gaps', () => {
    expect(align(axis, [{ bucket: 'b', n: 5 }], (r) => r.n))
      .toEqual([{ bucket: 'a', value: null }, { bucket: 'b', value: 5 }, { bucket: 'c', value: null }]);
  });

  it('alignCounts fills missing buckets with real zeroes', () => {
    expect(alignCounts(axis, [{ bucket: 'b', count: 2 }]))
      .toEqual([{ bucket: 'a', value: 0 }, { bucket: 'b', value: 2 }, { bucket: 'c', value: 0 }]);
  });

  it('alignBand carries p50/p90, nulling absent buckets', () => {
    expect(alignBand(axis, [{ bucket: 'b', p50: 10, p90: 20 }]))
      .toEqual([
        { bucket: 'a', p50: null, p90: null },
        { bucket: 'b', p50: 10, p90: 20 },
        { bucket: 'c', p50: null, p90: null },
      ]);
  });
});

describe('metricsModel — deltaText', () => {
  it('formats a signed percentage vs prev', () => {
    expect(deltaText(stat(150, 100))).toBe('+50% vs prev');
    expect(deltaText(stat(80, 100))).toBe('-20% vs prev');
  });
  it('says "≈ prev" when rounded delta is zero, and null when not computable', () => {
    expect(deltaText(stat(100, 100))).toBe('≈ prev');
    expect(deltaText(stat(null, 100))).toBeNull();
    expect(deltaText(stat(50, 0))).toBeNull();
  });
});

describe('metricsModel — formatters & headlines', () => {
  it('fmtMinutes: whole at ≥10m, one decimal below', () => {
    expect(fmtMinutes(12.4)).toBe('12m');
    expect(fmtMinutes(3.46)).toBe('3.5m');
  });
  it('fmtDollars / fmtPct / fmtCount', () => {
    expect(fmtDollars(1.5)).toBe('$1.50');
    expect(fmtPct(33.4)).toBe('33%');
    expect(fmtCount(4.6)).toBe('5');
  });
  it('calibrationHeadline reads optimistic for positive error, pessimistic for negative', () => {
    expect(calibrationHeadline(0, 8)).toBe('p50 ETAs on target (n=8)');
    expect(calibrationHeadline(20, 8)).toBe('p50 ETAs run 20% optimistic (n=8)');
    expect(calibrationHeadline(-15, 8)).toBe('p50 ETAs run 15% pessimistic (n=8)');
  });
});

describe('metricsModel — resolveRecLink', () => {
  it('maps known kinds, lint:* by prefix, and unknown to null', () => {
    expect(resolveRecLink('batch-size')).toEqual({ section: 'throughput', panel: 'metrics-batch-advisor' });
    expect(resolveRecLink('lint:no-cache')).toEqual({ section: 'reliability', panel: 'metrics-workflow-lint' });
    expect(resolveRecLink('totally-unknown')).toBeNull();
  });
});
