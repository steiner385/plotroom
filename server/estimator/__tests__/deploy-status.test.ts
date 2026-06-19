import { describe, it, expect } from 'vitest';
import { computeRepoDeploy } from '../deploy-status';
import type { HistoryStore } from '../../history';
import type { DeployConfig } from '../../config';

const DC: DeployConfig = {
  environments: [
    { name: 'qa', healthUrl: 'https://qa/health', auto: true, shaKey: 'sha' },
    { name: 'prod', healthUrl: 'https://prod/health', auto: true, shaKey: 'sha' },
  ],
  cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main',
};

const rec = (number: number, qaLiveAt: string | null, prodLiveAt: string | null) => ({
  repo: 'o/r', number, title: `pr ${number}`, url: '', mergedAt: '2026-06-18T00:00:00Z',
  mergeCommitSha: `sha${number}`, createdAt: null, firstGreenAt: null, enqueuedAt: null,
  qaLiveAt, prodLiveAt, mergedBy: null,
});
const hist = (records: ReturnType<typeof rec>[]) =>
  ({ listTrackedMerged: () => records } as unknown as HistoryStore);

describe('computeRepoDeploy awaiting partition (awaiting-QA vs awaiting-prod must not double-count)', () => {
  it('counts a not-yet-QA merge as awaiting QA only — NOT also awaiting prod', () => {
    const s = computeRepoDeploy(hist([rec(1, null, null)]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(1);
    expect(s.awaitingProd).toBe(0); // it's awaiting QA, not prod
  });

  it('counts a QA-live-but-not-prod merge as awaiting prod only', () => {
    const s = computeRepoDeploy(hist([rec(1, '2026-06-18T00:30:00Z', null)]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(0);
    expect(s.awaitingProd).toBe(1);
  });

  it('counts a fully-deployed merge as neither', () => {
    const s = computeRepoDeploy(hist([rec(1, '2026-06-18T00:30:00Z', '2026-06-18T00:45:00Z')]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(0);
    expect(s.awaitingProd).toBe(0);
  });

  it('partitions a mixed set cleanly (1 awaiting QA, 1 awaiting prod, 1 done)', () => {
    const s = computeRepoDeploy(hist([
      rec(1, null, null),                                   // awaiting QA
      rec(2, '2026-06-18T00:30:00Z', null),                 // awaiting prod
      rec(3, '2026-06-18T00:30:00Z', '2026-06-18T00:45:00Z'), // done
    ]), 'o/r', DC, new Map(), 7, new Date('2026-06-18T01:00:00Z'));
    expect(s.awaitingQa).toBe(1);
    expect(s.awaitingProd).toBe(1);
  });
});

describe('computeRepoDeploy excludes superseded merges from awaiting counts (#205)', () => {
  // mergedAt-explicit record helper (the default `rec` fixes mergedAt).
  const recAt = (number: number, mergedAt: string, qaLiveAt: string | null, prodLiveAt: string | null) => ({
    repo: 'o/r', number, title: `pr ${number}`, url: '', mergedAt,
    mergeCommitSha: `sha${number}`, createdAt: null, firstGreenAt: null, enqueuedAt: null,
    qaLiveAt, prodLiveAt, mergedBy: null,
  });
  const now = new Date('2026-06-18T01:00:00Z');

  it('an older not-yet-QA merge superseded by a newer prod-live merge is NOT awaiting (sub-PR/squash case)', () => {
    const s = computeRepoDeploy(hist([
      recAt(1, '2026-06-15T00:00:00Z', null, null),                                          // never deploys on its own
      recAt(2, '2026-06-18T00:00:00Z', '2026-06-18T00:30:00Z', '2026-06-18T00:45:00Z'),      // newer, on prod
    ]), 'o/r', DC, new Map(), 7, now);
    expect(s.awaitingQa).toBe(0);    // PR#1 suppressed (would have been 1 before the fix)
    expect(s.awaitingProd).toBe(0);
    expect(s.chain.entries.find((e) => e.prNumber === 1)!.superseded).toBe(true); // still in the detail
  });

  it('an older QA-live-but-not-prod merge superseded by a newer prod merge is NOT awaiting prod', () => {
    const s = computeRepoDeploy(hist([
      recAt(1, '2026-06-15T00:00:00Z', '2026-06-15T01:00:00Z', null),
      recAt(2, '2026-06-18T00:00:00Z', '2026-06-18T00:30:00Z', '2026-06-18T00:45:00Z'),
    ]), 'o/r', DC, new Map(), 7, now);
    expect(s.awaitingProd).toBe(0);
  });

  it('the newest non-prod merge is still counted (NOT over-suppressed)', () => {
    const s = computeRepoDeploy(hist([
      recAt(1, '2026-06-18T00:00:00Z', null, null),                                          // newest — genuinely in-flight
      recAt(2, '2026-06-15T00:00:00Z', '2026-06-15T01:00:00Z', '2026-06-15T02:00:00Z'),      // older, on prod
    ]), 'o/r', DC, new Map(), 7, now);
    expect(s.awaitingQa).toBe(1);    // newer than the prod merge → not superseded → still awaiting
  });
});
