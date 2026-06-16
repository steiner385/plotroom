import { describe, it, expect } from 'vitest';
import {
  computeDemotionCandidates, DEMOTION_DEFAULTS, DEMOTION_MIN_RUNS,
  type SuccessStat,
} from '../demotion-candidates';

const stat = (over: Partial<SuccessStat>): SuccessStat => ({
  name: 'check', event: 'pull_request', totalRuns: 100, failingRuns: 0, sumDurationSecs: 60_000, ...over,
});

/** A merge_group gate row for `name`, so a same-named PR row is demotable. */
const gate = (name: string): SuccessStat =>
  ({ name, event: 'merge_group', totalRuns: 100, failingRuns: 0, sumDurationSecs: 1 });

describe('computeDemotionCandidates — gate safety', () => {
  it('NEVER demotes a merge_group check (it is the terminal gate), however green/expensive', () => {
    const cands = computeDemotionCandidates([
      stat({ name: 'build', event: 'merge_group', totalRuns: 500, failingRuns: 0, sumDurationSecs: 999_999 }),
    ]);
    expect(cands).toEqual([]);
  });

  it('demotes a pull_request check ONLY when the same check still gates in the queue', () => {
    const withGate = computeDemotionCandidates([stat({ name: 'build' }), gate('build')]);
    expect(withGate.map((c) => c.name)).toEqual(['build']);
    expect(withGate[0]).toMatchObject({ currentTier: 'every PR push', suggestedTier: 'merge queue only' });
  });

  it('suppresses a pull_request check with NO merge_group gate (demoting would ungate it)', () => {
    const noGate = computeDemotionCandidates([stat({ name: 'pr-only' })]);
    expect(noGate).toEqual([]);
  });

  it('a check on both events yields only the PR candidate — the gate row is never demoted, so it cannot be double-demoted into nothing', () => {
    const cands = computeDemotionCandidates([
      stat({ name: 'db', event: 'pull_request', sumDurationSecs: 70_000 }),
      stat({ name: 'db', event: 'merge_group', sumDurationSecs: 80_000 }),
    ]);
    expect(cands.map((c) => `${c.name}/${c.event}`)).toEqual(['db/pull_request']);
  });

  it('allows push → nightly (a post-merge backstop, not a gate)', () => {
    const [c] = computeDemotionCandidates([stat({ name: 'e2e', event: 'push' })]);
    expect(c).toMatchObject({ currentTier: 'every push to main', suggestedTier: 'nightly' });
  });
});

describe('computeDemotionCandidates — ranking & thresholds', () => {
  it('ranks qualifying checks by cost (runner-minutes) descending', () => {
    const cands = computeDemotionCandidates([
      stat({ name: 'cheap', sumDurationSecs: 6_000 }), gate('cheap'),     // 100 min
      stat({ name: 'pricey', sumDurationSecs: 60_000 }), gate('pricey'),  // 1000 min
      stat({ name: 'mid', sumDurationSecs: 30_000 }), gate('mid'),        // 500 min
    ]);
    expect(cands.map((c) => c.name)).toEqual(['pricey', 'mid', 'cheap']);
    expect(cands[0]!.minutesInWindow).toBe(1000);
  });

  it('excludes checks below the minimum run count (insufficient history)', () => {
    const cands = computeDemotionCandidates([stat({ name: 'x', totalRuns: DEMOTION_MIN_RUNS - 1 }), gate('x')]);
    expect(cands).toEqual([]);
  });

  it('excludes checks below the success threshold (flaky / failing)', () => {
    const cands = computeDemotionCandidates([stat({ name: 'x', totalRuns: 100, failingRuns: 5 }), gate('x')]);
    expect(cands).toEqual([]);
  });

  it('admits a check at exactly the ≥99% bar', () => {
    const cands = computeDemotionCandidates([stat({ name: 'x', totalRuns: 100, failingRuns: 1 }), gate('x')]);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.successRatePct).toBe(99);
  });

  it('caps the list at topN', () => {
    const many = Array.from({ length: 20 }, (_, i) => i).flatMap((i) =>
      [stat({ name: `c${i}`, sumDurationSecs: (i + 1) * 6_000 }), gate(`c${i}`)]);
    expect(computeDemotionCandidates(many, { ...DEMOTION_DEFAULTS, topN: 5 })).toHaveLength(5);
  });

  it('builds a human reason with the green ratio and cost', () => {
    const [c] = computeDemotionCandidates([
      stat({ name: 'x', totalRuns: 120, failingRuns: 0, sumDurationSecs: 72_000 }), gate('x'),
    ]);
    expect(c!.reason).toBe('120/120 green · ~1200 runner-min in window');
  });
});
