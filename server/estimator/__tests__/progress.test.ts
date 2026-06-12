import { describe, it, expect } from 'vitest';
import { computeProgress } from '../progress';
import type { CheckRun } from '../../types';
import type { Expected } from '../../history';

const NOW = new Date('2026-06-10T10:10:00Z');
const run = (over: Partial<CheckRun>): CheckRun => ({
  name: 'x', rawName: 'x', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:05:00Z',
  event: 'pull_request', workflowName: null, runNumber: null, runAttempt: null, isRequired: true, url: null, ...over,
});
// p10 defaults to p50 — progress math only reads p50/p90, so fixtures stay terse
const lookupOf = (m: Record<string, Omit<Expected, 'p10'> & { p10?: number }>) =>
  (n: string): Expected | null => {
    const e = m[n];
    return e ? { p10: e.p50, ...e } : null;
  };
const noLookup = () => null;

describe('computeProgress', () => {
  it('weights by expected duration (long shard dominates short lint)', () => {
    const checks = [
      run({ name: 'lint', status: 'COMPLETED' }),
      run({ name: 'shard', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-06-10T10:05:00Z', completedAt: null }),
    ];
    const r = computeProgress({
      checks, expectedSet: ['lint', 'shard'],
      lookup: lookupOf({ lint: { p50: 30, p90: 35, n: 20 }, shard: { p50: 600, p90: 700, n: 20 } }),
      now: NOW,
    });
    // lint: 30*1; shard elapsed 300/600 = 0.5 → 600*0.5; total (30+300)/630 ≈ 52%
    expect(r.percent).toBe(52);
    expect(r.etaSeconds).toBe(300); // critical path = shard remaining
    expect(r.overdue).toBe(false);
  });

  it('counts history-expected checks missing from the live rollup as queued (denominator from history)', () => {
    const checks = [run({ name: 'lint', status: 'COMPLETED' })];
    const r = computeProgress({
      checks, expectedSet: ['lint', 'shard'],
      lookup: lookupOf({ lint: { p50: 30, p90: 35, n: 20 }, shard: { p50: 600, p90: 700, n: 20 } }),
      now: NOW,
    });
    expect(r.percent).toBe(5); // 30/630
    expect(r.etaSeconds).toBe(600);
  });

  it('SKIPPED checks carry zero weight', () => {
    const checks = [
      run({ name: 'lint' }),
      run({ name: 'shard', conclusion: 'SKIPPED' }),
    ];
    const r = computeProgress({
      checks, expectedSet: ['lint', 'shard'],
      lookup: lookupOf({ lint: { p50: 30, p90: 35, n: 20 }, shard: { p50: 600, p90: 700, n: 20 } }),
      now: NOW,
    });
    expect(r.percent).toBe(100);
    expect(r.etaSeconds).toBe(0);
  });

  it('flags overdue past 1.5x expected and suppresses the ETA', () => {
    const checks = [run({ name: 'shard', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-06-10T09:50:00Z', completedAt: null })];
    const r = computeProgress({
      checks, expectedSet: ['shard'],
      lookup: lookupOf({ shard: { p50: 600, p90: 660, n: 20 } }), // elapsed 1200 > 900
      now: NOW,
    });
    expect(r.overdue).toBe(true);
    expect(r.etaSeconds).toBeNull();
    expect(r.percent).toBeLessThanOrEqual(97);
  });

  it('returns an ETA range when variance is wide (p90/p50 > 2)', () => {
    const checks = [run({ name: 'cold', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null })];
    const r = computeProgress({
      checks, expectedSet: ['cold'],
      lookup: lookupOf({ cold: { p50: 100, p90: 300, n: 20 } }),
      now: NOW,
    });
    expect(r.etaSeconds).toBe(100);
    expect(r.etaRangeSeconds).toEqual([100, 300]);
  });

  it('falls back to median-of-known weights for unknown check names', () => {
    const checks = [
      run({ name: 'known' }),
      run({ name: 'mystery', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-06-10T10:09:00Z', completedAt: null }),
    ];
    const r = computeProgress({
      checks, expectedSet: ['known'],
      lookup: lookupOf({ known: { p50: 120, p90: 130, n: 20 } }),
      now: NOW,
    });
    expect(r.percent).toBeGreaterThan(0);
    expect(r.percent).toBeLessThan(100);
    expect(r.etaSeconds).not.toBeNull();
  });

  it('all complete → 100%, eta 0', () => {
    const r = computeProgress({
      checks: [run({ name: 'a' }), run({ name: 'b' })], expectedSet: ['a', 'b'],
      lookup: lookupOf({}), now: NOW,
    });
    expect(r.percent).toBe(100);
    expect(r.etaSeconds).toBe(0);
  });

  // Item 1 — elapsed sanitization
  it('malformed startedAt ("garbage") is treated as queued — percent is finite, no NaN', () => {
    const checks = [run({ name: 'ci', status: 'IN_PROGRESS', conclusion: null,
      startedAt: 'garbage', completedAt: null })];
    const r = computeProgress({
      checks, expectedSet: ['ci'],
      lookup: lookupOf({ ci: { p50: 300, p90: 360, n: 10 } }),
      now: NOW,
    });
    expect(Number.isFinite(r.percent)).toBe(true);
    expect(r.percent).toBeGreaterThanOrEqual(0);
    expect(r.percent).toBeLessThan(100);
    expect(Number.isNaN(r.percent)).toBe(false);
    if (r.etaSeconds !== null) expect(Number.isNaN(r.etaSeconds)).toBe(false);
  });

  it('future startedAt (5 min ahead) is clamped — percent >= 0, no NaN', () => {
    // startedAt is 5 minutes AFTER now — elapsed would be -300s without clamping
    const futureStart = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
    const checks = [run({ name: 'ci', status: 'IN_PROGRESS', conclusion: null,
      startedAt: futureStart, completedAt: null })];
    const r = computeProgress({
      checks, expectedSet: ['ci'],
      lookup: lookupOf({ ci: { p50: 300, p90: 360, n: 10 } }),
      now: NOW,
    });
    expect(r.percent).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(r.percent)).toBe(false);
  });

  // Item 2 — failed flag on ProgressResult
  it('FAILURE check + running check → failed: true, percent reflects running progress', () => {
    const checks = [
      run({ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }),
      run({ name: 'shard', status: 'IN_PROGRESS', conclusion: null,
        startedAt: '2026-06-10T10:05:00Z', completedAt: null }),
    ];
    const r = computeProgress({
      checks, expectedSet: ['lint', 'shard'],
      lookup: lookupOf({ lint: { p50: 30, p90: 35, n: 20 }, shard: { p50: 600, p90: 700, n: 20 } }),
      now: NOW,
    });
    expect(r.failed).toBe(true);
    // FAILURE counts as progress=1, same as SUCCESS — percent should be > 50%
    expect(r.percent).toBeGreaterThan(50);
  });

  it('CANCELLED check does NOT set failed: true', () => {
    const checks = [run({ name: 'ci', status: 'COMPLETED', conclusion: 'CANCELLED' })];
    const r = computeProgress({
      checks, expectedSet: ['ci'],
      lookup: lookupOf({ ci: { p50: 60, p90: 90, n: 10 } }),
      now: NOW,
    });
    expect(r.failed).toBe(false);
  });

  it('TIMED_OUT and STARTUP_FAILURE set failed: true', () => {
    const r1 = computeProgress({
      checks: [run({ name: 'ci', status: 'COMPLETED', conclusion: 'TIMED_OUT' })],
      expectedSet: ['ci'],
      lookup: lookupOf({ ci: { p50: 60, p90: 90, n: 10 } }),
      now: NOW,
    });
    expect(r1.failed).toBe(true);

    const r2 = computeProgress({
      checks: [run({ name: 'ci', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })],
      expectedSet: ['ci'],
      lookup: lookupOf({ ci: { p50: 60, p90: 90, n: 10 } }),
      now: NOW,
    });
    expect(r2.failed).toBe(true);
  });

  // Item 3 — variance guard: wide-variance requires p50 > 0
  it('p50=0 does not produce an ETA range (variance guard)', () => {
    // If p50=0 and p90=1, the ratio check would be p90/p50=∞ without the guard
    const checks = [run({ name: 'ci', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null })];
    const r = computeProgress({
      checks, expectedSet: ['ci'],
      lookup: lookupOf({ ci: { p50: 0, p90: 1, n: 5 } }),
      now: NOW,
    });
    expect(r.etaRangeSeconds).toBeNull();
  });

  // Task G (round 2, item 10) — conditional-remaining estimator
  describe('conditional-remaining estimator (samples provided)', () => {
    const BIMODAL = [120, 120, 120, 120, 120, 120, 600, 600, 600, 600, 600, 600];
    const samplesOf = (m: Record<string, number[]>) => (n: string) => m[n] ?? [];
    const inProgress = (startedAt: string) =>
      [run({ name: 'ci', status: 'IN_PROGRESS' as const, conclusion: null, startedAt, completedAt: null })];
    // lower median of BIMODAL = 120, p90 = 600
    const bimodalLookup = lookupOf({ ci: { p50: 120, p90: 600, n: 12 } });

    it('bimodal, elapsed 150 → re-anchors to the slow mode: rem50 = 450, not max(p50−elapsed,0)=0', () => {
      const r = computeProgress({
        checks: inProgress('2026-06-10T10:07:30Z'), // elapsed 150s at NOW
        expectedSet: ['ci'], lookup: bimodalLookup, now: NOW,
        samples: samplesOf({ ci: BIMODAL }),
      });
      expect(r.overdue).toBe(false);
      expect(r.etaSeconds).toBe(450); // median(qualifying [600×6]) − 150
    });

    it('bimodal, elapsed 150, rem50=450 → progress ≈ 25% (not pegged 97% from elapsed/p50)', () => {
      // Single-check input so aggregate percent == that check's progress.
      // elapsed=150, rem50=450 → 150/(150+450) = 0.25 → 25%
      const r = computeProgress({
        checks: inProgress('2026-06-10T10:07:30Z'), // elapsed 150s at NOW
        expectedSet: ['ci'], lookup: bimodalLookup, now: NOW,
        samples: samplesOf({ ci: BIMODAL }),
      });
      expect(r.percent).toBe(25);
    });

    it('elapsed beyond every sample → overdue, eta null — even when elapsed < 1.5×p50 (≥10 samples)', () => {
      // lookup p50 600 → the legacy overdue rule (1.5×600=900) would NOT fire at 700s;
      // the conditional rule must: every historical sample has been exceeded.
      const r = computeProgress({
        checks: inProgress('2026-06-10T09:58:20Z'), // elapsed 700s
        expectedSet: ['ci'], lookup: lookupOf({ ci: { p50: 600, p90: 660, n: 12 } }), now: NOW,
        samples: samplesOf({ ci: BIMODAL }), // 12 samples — bypass applies (≥10)
      });
      expect(r.overdue).toBe(true);
      expect(r.etaSeconds).toBeNull();
    });

    it('5-sample qualifying-empty at elapsed just past max-sample but < 1.5×p50 → NOT overdue', () => {
      // 5 samples all at 200s; elapsed=210 exceeds every sample but < 1.5×300=450.
      // With only 5 samples the bypass must NOT fire — falls back to legacy 1.5×p50 rule.
      const fiveSamples = [200, 200, 200, 200, 200];
      const r = computeProgress({
        checks: inProgress('2026-06-10T10:06:30Z'), // elapsed 210s at NOW (10:10:00 − 10:06:30)
        expectedSet: ['ci'], lookup: lookupOf({ ci: { p50: 300, p90: 350, n: 5 } }), now: NOW,
        samples: samplesOf({ ci: fiveSamples }),
      });
      expect(r.overdue).toBe(false);
    });

    it('unimodal samples ≈ old behavior (rem50 = p50 − elapsed)', () => {
      const r = computeProgress({
        checks: inProgress('2026-06-10T10:08:20Z'), // elapsed 100s
        expectedSet: ['ci'], lookup: lookupOf({ ci: { p50: 300, p90: 320, n: 10 } }), now: NOW,
        samples: samplesOf({ ci: [300, 300, 300, 300, 300, 300, 300, 300, 300, 300] }),
      });
      expect(r.overdue).toBe(false);
      expect(r.etaSeconds).toBe(200);
    });

    it('exactly 1 qualifying sample → falls back to the p50/p90 path', () => {
      const r = computeProgress({
        checks: inProgress('2026-06-10T10:07:30Z'), // elapsed 150s
        expectedSet: ['ci'], lookup: lookupOf({ ci: { p50: 200, p90: 220, n: 5 } }), now: NOW,
        samples: samplesOf({ ci: [100, 100, 100, 100, 700] }), // one sample > 150
      });
      // NOT median([700])−150 = 550; fallback rem50 = max(200−150, 0) = 50
      expect(r.etaSeconds).toBe(50);
      expect(r.overdue).toBe(false);
    });

    it('fewer than 5 total samples → current logic unchanged', () => {
      const r = computeProgress({
        checks: inProgress('2026-06-10T10:07:30Z'), // elapsed 150s
        expectedSet: ['ci'], lookup: lookupOf({ ci: { p50: 200, p90: 220, n: 4 } }), now: NOW,
        samples: samplesOf({ ci: [600, 600, 600, 600] }),
      });
      expect(r.etaSeconds).toBe(50); // max(200−150, 0), not 450
    });

    it('fallback path inside the conditional branch still applies the 1.5×p50 overdue rule', () => {
      const r = computeProgress({
        checks: inProgress('2026-06-10T10:05:00Z'), // elapsed 300s > 1.5×180=270
        expectedSet: ['ci'], lookup: lookupOf({ ci: { p50: 180, p90: 200, n: 5 } }), now: NOW,
        samples: samplesOf({ ci: [100, 100, 100, 100, 700] }), // exactly 1 qualifying
      });
      expect(r.overdue).toBe(true);
      expect(r.etaSeconds).toBeNull();
    });

    it('samples only affect IN_PROGRESS checks — queued checks keep p50/p90', () => {
      const r = computeProgress({
        checks: [run({ name: 'ci', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null })],
        expectedSet: ['ci'], lookup: lookupOf({ ci: { p50: 200, p90: 220, n: 12 } }), now: NOW,
        samples: samplesOf({ ci: BIMODAL }),
      });
      expect(r.etaSeconds).toBe(200);
    });
  });

  // Item 12 — COMPLETED FAILURE counts toward percent (explicit test)
  it('COMPLETED FAILURE counts toward progress (same weight as SUCCESS)', () => {
    const checks = [
      run({ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }),
      run({ name: 'b', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null }),
    ];
    const r = computeProgress({
      checks, expectedSet: ['a', 'b'],
      lookup: lookupOf({ a: { p50: 100, p90: 120, n: 10 }, b: { p50: 100, p90: 120, n: 10 } }),
      now: NOW,
    });
    // a is done (progress=1), b is queued (progress=0) → 50%
    expect(r.percent).toBe(50);
  });
});

describe('computeProgress queueDelay (W2: learned runner-pickup waits)', () => {
  const lookup = lookupOf({ shard: { p50: 300, p90: 300, n: 20 } });

  it('adds the expected runner wait to queued checks (rem50 and rem90)', () => {
    const checks = [run({ name: 'shard', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null })];
    const r = computeProgress({ checks, expectedSet: ['shard'], lookup, now: NOW,
      queueDelay: (n) => (n === 'shard' ? 120 : null) });
    expect(r.etaSeconds).toBe(420); // 300 p50 + 120 expected pickup wait
  });

  it('adds the delay to expected-from-history checks that have not appeared yet', () => {
    const r = computeProgress({ checks: [], expectedSet: ['shard'], lookup, now: NOW,
      queueDelay: () => 120 });
    expect(r.etaSeconds).toBe(420);
  });

  it('does NOT add the delay to running checks', () => {
    const checks = [run({ name: 'shard', status: 'IN_PROGRESS', conclusion: null,
      startedAt: '2026-06-10T10:05:00Z', completedAt: null })];
    const r = computeProgress({ checks, expectedSet: ['shard'], lookup, now: NOW,
      queueDelay: () => 120 });
    expect(r.etaSeconds).toBe(0); // elapsed 300 ≥ p50 300 → remaining 0, no delay added
  });

  it('a null delay leaves the queued estimate unchanged', () => {
    const checks = [run({ name: 'shard', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null })];
    const r = computeProgress({ checks, expectedSet: ['shard'], lookup, now: NOW,
      queueDelay: () => null });
    expect(r.etaSeconds).toBe(300);
  });
});
