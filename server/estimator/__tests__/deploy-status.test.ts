import { describe, it, expect } from 'vitest';
import { computeRepoDeploy } from '../deploy-status';
import type { HistoryStore } from '../../history';
import type { DeployConfig } from '../../config';

/** Two-env DeployConfig fixture: staging→production. */
const DC_TWO: DeployConfig = {
  environments: [
    { name: 'staging', healthUrl: 'https://staging/health', auto: true, shaKey: 'sha' },
    { name: 'production', healthUrl: 'https://production/health', auto: false, shaKey: 'sha' },
  ],
  order: ['staging', 'production'],
  cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main',
};

/** Legacy two-env fixture (qa→prod) kept for the partition/supersession test groups. */
const DC: DeployConfig = {
  environments: [
    { name: 'qa', healthUrl: 'https://qa/health', auto: true, shaKey: 'sha' },
    { name: 'prod', healthUrl: 'https://prod/health', auto: true, shaKey: 'sha' },
  ],
  order: ['qa', 'prod'],
  cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main',
};

/** Single-env DeployConfig fixture: only production. */
const DC_SINGLE: DeployConfig = {
  environments: [
    { name: 'production', healthUrl: 'https://production/health', auto: true, shaKey: 'sha' },
  ],
  order: ['production'],
  cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main',
};

/** Build a MergedPrRecord-shaped stub with an envLive map. */
const rec = (number: number, qaLiveAt: string | null, prodLiveAt: string | null) => ({
  repo: 'o/r', number, title: `pr ${number}`, url: '', mergedAt: '2026-06-18T00:00:00Z',
  mergeCommitSha: `sha${number}`, createdAt: null, firstGreenAt: null, enqueuedAt: null,
  envLive: {
    ...(qaLiveAt ? { qa: qaLiveAt } : {}),
    ...(prodLiveAt ? { prod: prodLiveAt } : {}),
  },
  // backward-compat fields still present on MergedPrRecord
  qaLiveAt, prodLiveAt, mergedBy: null,
});

/** Build a record with envLive keyed on staging/production instead of qa/prod. */
const recSP = (number: number, stagingLiveAt: string | null, productionLiveAt: string | null) => ({
  repo: 'o/r', number, title: `pr ${number}`, url: '', mergedAt: '2026-06-18T00:00:00Z',
  mergeCommitSha: `sha${number}`, createdAt: null, firstGreenAt: null, enqueuedAt: null,
  envLive: {
    ...(stagingLiveAt ? { staging: stagingLiveAt } : {}),
    ...(productionLiveAt ? { production: productionLiveAt } : {}),
  },
  qaLiveAt: null, prodLiveAt: null, mergedBy: null,
});

/** Build a record for single-env (production only). */
const recProd = (number: number, productionLiveAt: string | null) => ({
  repo: 'o/r', number, title: `pr ${number}`, url: '', mergedAt: '2026-06-18T00:00:00Z',
  mergeCommitSha: `sha${number}`, createdAt: null, firstGreenAt: null, enqueuedAt: null,
  envLive: { ...(productionLiveAt ? { production: productionLiveAt } : {}) },
  qaLiveAt: null, prodLiveAt: null, mergedBy: null,
});

const hist = (records: ReturnType<typeof rec | typeof recSP | typeof recProd>[]) =>
  ({ listTrackedMerged: () => records } as unknown as HistoryStore);

// ---- New staging→production fixture tests (primary TDD target) --------------

describe('computeRepoDeploy with order:[staging,production] (first/terminal model)', () => {
  const now = new Date('2026-06-18T01:00:00Z');

  it('reports firstEnv=staging and terminalEnv=production', () => {
    const s = computeRepoDeploy(hist([]), 'o/r', DC_TWO, new Map(), 7, now);
    expect(s.firstEnv).toBe('staging');
    expect(s.terminalEnv).toBe('production');
  });

  it('a merge live on staging only → awaitingProd===1, awaitingQa===0', () => {
    const s = computeRepoDeploy(
      hist([recSP(1, '2026-06-18T00:30:00Z', null)]),
      'o/r', DC_TWO, new Map(), 7, now,
    );
    expect(s.awaitingQa).toBe(0);    // already past first env
    expect(s.awaitingProd).toBe(1);  // awaiting terminal (production)
  });

  it('a merge not yet on staging → awaitingQa===1, awaitingProd===0', () => {
    const s = computeRepoDeploy(
      hist([recSP(1, null, null)]),
      'o/r', DC_TWO, new Map(), 7, now,
    );
    expect(s.awaitingQa).toBe(1);   // awaiting first env (staging)
    expect(s.awaitingProd).toBe(0);
  });

  it('a merge live on both staging and production → neither awaiting bucket', () => {
    const s = computeRepoDeploy(
      hist([recSP(1, '2026-06-18T00:30:00Z', '2026-06-18T00:45:00Z')]),
      'o/r', DC_TWO, new Map(), 7, now,
    );
    expect(s.awaitingQa).toBe(0);
    expect(s.awaitingProd).toBe(0);
  });

  it('envs array is ordered by dc.order (staging first, production second)', () => {
    const s = computeRepoDeploy(hist([]), 'o/r', DC_TWO, new Map(), 7, now);
    expect(s.envs.map((e) => e.name)).toEqual(['staging', 'production']);
  });
});

// ---- Single-env case: order:['production'] -----------------------------------

describe('computeRepoDeploy with order:[production] (single-env)', () => {
  const now = new Date('2026-06-18T01:00:00Z');

  it('reports firstEnv===terminalEnv===production', () => {
    const s = computeRepoDeploy(hist([]), 'o/r', DC_SINGLE, new Map(), 7, now);
    expect(s.firstEnv).toBe('production');
    expect(s.terminalEnv).toBe('production');
  });

  it('a merge live on production is fully deployed — awaitingQa===0, awaitingProd===0', () => {
    const s = computeRepoDeploy(
      hist([recProd(1, '2026-06-18T00:30:00Z')]),
      'o/r', DC_SINGLE, new Map(), 7, now,
    );
    expect(s.awaitingQa).toBe(0);
    expect(s.awaitingProd).toBe(0);
  });

  it('a merge not yet on production → awaitingQa===1, awaitingProd===0', () => {
    const s = computeRepoDeploy(
      hist([recProd(1, null)]),
      'o/r', DC_SINGLE, new Map(), 7, now,
    );
    expect(s.awaitingQa).toBe(1);   // awaiting the only env (which is first and terminal)
    expect(s.awaitingProd).toBe(0); // can never be awaiting prod when it's not even on first
  });
});

// ---- Ported partition tests (qa/prod fixtures updated to envLive model) ------

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
  const recAt = (number: number, mergedAt: string, qaLiveAt: string | null, prodLiveAt: string | null) => ({
    repo: 'o/r', number, title: `pr ${number}`, url: '', mergedAt,
    mergeCommitSha: `sha${number}`, createdAt: null, firstGreenAt: null, enqueuedAt: null,
    envLive: {
      ...(qaLiveAt ? { qa: qaLiveAt } : {}),
      ...(prodLiveAt ? { prod: prodLiveAt } : {}),
    },
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
