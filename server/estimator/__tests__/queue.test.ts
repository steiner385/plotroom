import { describe, it, expect } from 'vitest';
import { queueStage } from '../queue';
import type { QueueEntry } from '../../types';

const e = (position: number, prNumber: number, state: string, headCommitOid: string | null = null): QueueEntry =>
  ({ position, prNumber, state, headCommitOid, enqueuedAt: null });

const GROUPS = [
  { oid: 'g1', percent: 80, etaSeconds: 120, overdue: false, failed: false },
  { oid: 'g2', percent: 30, etaSeconds: 600, overdue: false, failed: false },
];

describe('queueStage', () => {
  it('entry in a building group uses that group progress directly', () => {
    const r = queueStage({
      entries: [e(1, 100, 'AWAITING_CHECKS', 'g1'), e(2, 200, 'AWAITING_CHECKS', 'g2')],
      prNumber: 200, groups: GROUPS, medianGroupSecs: 900, batchSize: 6,
    });
    expect(r.percent).toBe(30);
    expect(r.etaSeconds).toBe(600);
  });

  it('QUEUED entry waits for the deepest building group plus batched future runs', () => {
    // 2 building groups ahead + 7 queued ahead; batch 6 → me (8th queued) is in run 2
    const entries = [
      e(1, 100, 'AWAITING_CHECKS', 'g1'), e(2, 200, 'AWAITING_CHECKS', 'g2'),
      ...Array.from({ length: 7 }, (_, k) => e(3 + k, 300 + k, 'QUEUED')),
      e(10, 999, 'QUEUED'),
    ];
    const r = queueStage({ entries, prNumber: 999, groups: GROUPS, medianGroupSecs: 900, batchSize: 6 });
    // deepest building group eta 600 + ceil((7+1)/6)=2 runs * 900 = 2400
    expect(r.etaSeconds).toBe(600 + 2 * 900);
    expect(r.percent).toBeNull();
    // Item 9: renamed queuedBehind → aheadCount
    expect(r.aheadCount).toBe(9);
  });

  it('QUEUED entry with nothing building: pure batch math', () => {
    const r = queueStage({
      entries: [e(1, 100, 'QUEUED'), e(2, 999, 'QUEUED')],
      prNumber: 999, groups: [], medianGroupSecs: 900, batchSize: 6,
    });
    expect(r.etaSeconds).toBe(900); // both fit in one batch
  });

  it('falls back to default median when no history; missing entry → nulls', () => {
    const r = queueStage({
      entries: [e(1, 999, 'AWAITING_CHECKS', 'unknown-oid')],
      prNumber: 999, groups: [], medianGroupSecs: null, batchSize: 6,
    });
    expect(r.etaSeconds).toBe(900); // DEFAULT_GROUP_SECS
    const r2 = queueStage({ entries: [], prNumber: 1, groups: [], medianGroupSecs: null, batchSize: 6 });
    expect(r2.etaSeconds).toBeNull();
  });

  // Item 8 — building = AWAITING_CHECKS && headCommitOid; MERGEABLE excluded from both building and aheadCount
  it('MERGEABLE entry ahead is excluded from building count and aheadCount (occupies no future capacity)', () => {
    const entries = [
      e(1, 100, 'MERGEABLE', 'merged-oid'), // done, awaiting merge — excluded
      e(2, 200, 'AWAITING_CHECKS', 'g1'),    // building
      e(3, 999, 'QUEUED'),                   // me
    ];
    const r = queueStage({ entries, prNumber: 999, groups: GROUPS, medianGroupSecs: 900, batchSize: 6 });
    // MERGEABLE at pos 1 should not be counted as building or in aheadCount
    // Only AWAITING_CHECKS g1 is building (eta 120), 0 queued-ahead (MERGEABLE excluded)
    // futureRuns = ceil((0+1)/6) = 1; eta = 120 + 1*900 = 1020
    expect(r.etaSeconds).toBe(120 + 900);
    expect(r.aheadCount).toBe(1); // only the AWAITING_CHECKS entry
  });

  it('AWAITING_CHECKS without headCommitOid is NOT building (no CI group yet)', () => {
    const entries = [
      e(1, 100, 'AWAITING_CHECKS', null), // AWAITING_CHECKS but no oid — not yet building
      e(2, 999, 'QUEUED'),
    ];
    const r = queueStage({ entries, prNumber: 999, groups: GROUPS, medianGroupSecs: 900, batchSize: 6 });
    // The AWAITING_CHECKS-no-oid entry counts as ahead (queuedAhead=1) but not building
    // deepestEta=0 (no building group); futureRuns = ceil((1+1)/6) = 1; eta = 0 + 1*900 = 900
    expect(r.aheadCount).toBe(1);
    expect(r.etaSeconds).toBe(900);
  });

  // Item 9 — aheadCount field exists (not queuedBehind)
  it('result has aheadCount (not queuedBehind)', () => {
    const r = queueStage({
      entries: [e(1, 100, 'QUEUED'), e(2, 999, 'QUEUED')],
      prNumber: 999, groups: [], medianGroupSecs: 900, batchSize: 6,
    });
    expect('aheadCount' in r).toBe(true);
    expect('queuedBehind' in r).toBe(false);
  });

  // Item 10 — failed propagation
  it('entry in a failed group → failed: true in result', () => {
    const groupsWithFailed = [
      { oid: 'g1', percent: 80, etaSeconds: 120, overdue: false, failed: true },
    ];
    const r = queueStage({
      entries: [e(1, 999, 'AWAITING_CHECKS', 'g1')],
      prNumber: 999, groups: groupsWithFailed, medianGroupSecs: 900, batchSize: 6,
    });
    expect(r.failed).toBe(true);
  });

  it('QUEUED entry (not yet in a group) → failed: false', () => {
    const r = queueStage({
      entries: [e(1, 999, 'QUEUED')],
      prNumber: 999, groups: GROUPS, medianGroupSecs: 900, batchSize: 6,
    });
    expect(r.failed).toBe(false);
  });
});
