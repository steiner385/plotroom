import { describe, it, expect } from 'vitest';
import { classifyWait, extractRunnerWaits } from '../waits';
import type { CheckRun } from '../../types';

const NOW = new Date('2026-06-10T12:00:00Z');

const run = (over: Partial<CheckRun>): CheckRun => ({
  name: 'x', rawName: 'x', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: '2026-06-10T11:50:00Z', completedAt: '2026-06-10T11:55:00Z',
  event: 'pull_request', workflowName: null, runNumber: null, runAttempt: null, isRequired: true, url: null, ...over,
});

const queued = (over: Partial<CheckRun>): CheckRun =>
  run({ status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null, ...over });

describe('classifyWait', () => {
  it('returns null for non-queued checks (COMPLETED, IN_PROGRESS)', () => {
    expect(classifyWait(run({}), [run({})], ['a'], NOW)).toBeNull();
    expect(classifyWait(run({ status: 'IN_PROGRESS', conclusion: null, completedAt: null }),
      [], ['a'], NOW)).toBeNull();
  });

  it('classifies every queued-family status (QUEUED/PENDING/REQUESTED/WAITING)', () => {
    for (const status of ['QUEUED', 'PENDING', 'REQUESTED', 'WAITING'] as const) {
      expect(classifyWait(queued({ status }), [], null, NOW)).toEqual({ kind: 'unknown' });
    }
  });

  it('unknown when the needs graph is unknown (null) or the node is a root (empty needs)', () => {
    expect(classifyWait(queued({}), [], null, NOW)).toEqual({ kind: 'unknown' });
    expect(classifyWait(queued({}), [], [], NOW)).toEqual({ kind: 'unknown' });
  });

  it('blocked on the first incomplete needed check (still running)', () => {
    const all = [
      queued({ name: 'static-checks / TypeScript' }),
      run({ name: 'Prepare (prisma + packages)', status: 'IN_PROGRESS', conclusion: null, completedAt: null }),
    ];
    expect(classifyWait(all[0]!, all, ['Prepare (prisma + packages)'], NOW))
      .toEqual({ kind: 'blocked', blockedOn: 'Prepare (prisma + packages)' });
  });

  it('blocked when a needed check COMPLETED with a failing conclusion (reported by name)', () => {
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', conclusion: 'FAILURE' }),
      run({ name: 'static-checks / TypeScript' }),
    ];
    expect(classifyWait(all[0]!, all, ['static-checks /', 'build'], NOW))
      .toEqual({ kind: 'blocked', blockedOn: 'build' });
  });

  it('blocked on the node prefix when a needed check has not appeared in the rollup yet', () => {
    const all = [queued({ name: 'ci' })];
    expect(classifyWait(all[0]!, all, ['static-checks /'], NOW))
      .toEqual({ kind: 'blocked', blockedOn: 'static-checks /' });
  });

  it('needed checks are matched within the same event only', () => {
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', event: 'merge_group' }), // other population — does not satisfy the need
    ];
    expect(classifyWait(all[0]!, all, ['build'], NOW))
      .toEqual({ kind: 'blocked', blockedOn: 'build' });
  });

  it('runner with waitingSeconds anchored on the LATEST needed completion', () => {
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', completedAt: '2026-06-10T11:55:00Z' }),
      run({ name: 'static-checks / TypeScript', completedAt: '2026-06-10T11:58:00Z' }),
      run({ name: 'static-checks / ESLint', completedAt: '2026-06-10T11:56:00Z' }),
    ];
    expect(classifyWait(all[0]!, all, ['build', 'static-checks /'], NOW))
      .toEqual({ kind: 'runner', waitingSeconds: 120 }); // 12:00 − 11:58
  });

  it('SKIPPED and NEUTRAL needed conclusions count as completed-ok', () => {
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', conclusion: 'SKIPPED', completedAt: '2026-06-10T11:57:00Z' }),
      run({ name: 'mobile', conclusion: 'NEUTRAL', completedAt: '2026-06-10T11:58:00Z' }),
    ];
    expect(classifyWait(all[0]!, all, ['build', 'mobile'], NOW))
      .toEqual({ kind: 'runner', waitingSeconds: 120 });
  });

  it('runner with null waitingSeconds when needed completions carry no timestamps', () => {
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', conclusion: 'SKIPPED', completedAt: null }),
    ];
    expect(classifyWait(all[0]!, all, ['build'], NOW))
      .toEqual({ kind: 'runner', waitingSeconds: null });
  });

  it('a need inactive for the check event is satisfied by absence (runner, not blocked)', () => {
    // PR-phase `ci` needs a merge_group-only job (android-smoke — absent from the
    // PR rollup) plus a completed universal job. Without event awareness this would
    // misclassify as blocked-on-android-smoke forever.
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', completedAt: '2026-06-10T11:58:00Z' }),
    ];
    const activeFor = (prefix: string, event: string) =>
      !(prefix === 'android-smoke /' && event === 'pull_request');
    expect(classifyWait(all[0]!, all, ['android-smoke /', 'build'], NOW, activeFor))
      .toEqual({ kind: 'runner', waitingSeconds: 120 }); // anchored on the universal job
  });

  it('every need inactive for the event → runner with null wait (no anchor, still honest)', () => {
    const all = [queued({ name: 'ci' })];
    expect(classifyWait(all[0]!, all, ['android-smoke /'], NOW, () => false))
      .toEqual({ kind: 'runner', waitingSeconds: null });
  });

  it('SKIPPED needs satisfy but never anchor waitingSeconds (placeholder timestamps)', () => {
    // skipped completedAt is LATER than the real completion — must not win the max
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', completedAt: '2026-06-10T11:55:00Z' }),
      run({ name: 'mobile', conclusion: 'SKIPPED', completedAt: '2026-06-10T11:59:00Z' }),
    ];
    expect(classifyWait(all[0]!, all, ['build', 'mobile'], NOW))
      .toEqual({ kind: 'runner', waitingSeconds: 300 }); // 12:00 − 11:55, not 11:59
  });

  it('all needs SKIPPED (even with completedAt) → runner with null wait', () => {
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build', conclusion: 'SKIPPED', completedAt: '2026-06-10T11:59:00Z' }),
    ];
    expect(classifyWait(all[0]!, all, ['build'], NOW))
      .toEqual({ kind: 'runner', waitingSeconds: null });
  });

  it('a foreign-workflow check cannot satisfy a need when the rollup workflow is known', () => {
    // `ci-gate` (Auto-merge PRs) longest-matches the `ci` graph node — without
    // workflow scoping it would satisfy a need on `ci` for downstream jobs.
    const graphKeys = ['ci', 'deploy'];
    const all = [
      queued({ name: 'deploy', workflowName: 'CI' }),
      run({ name: 'ci-gate', workflowName: 'Auto-merge PRs', completedAt: '2026-06-10T11:58:00Z' }),
    ];
    expect(classifyWait(all[0]!, all, ['ci'], NOW, undefined, graphKeys, 'CI'))
      .toEqual({ kind: 'blocked', blockedOn: 'ci' });
    // the real rollup-workflow `ci` check satisfies it
    const all2 = [...all, run({ name: 'ci', workflowName: 'CI', completedAt: '2026-06-10T11:55:00Z' })];
    expect(classifyWait(all2[0]!, all2, ['ci'], NOW, undefined, graphKeys, 'CI'))
      .toEqual({ kind: 'runner', waitingSeconds: 300 }); // anchored on ci, not ci-gate
  });

  it('null-workflow checks still satisfy needs under a known rollup workflow (permissive)', () => {
    const all = [
      queued({ name: 'ci', workflowName: 'CI' }),
      run({ name: 'build', workflowName: null, completedAt: '2026-06-10T11:58:00Z' }),
    ];
    expect(classifyWait(all[0]!, all, ['build'], NOW, undefined, null, 'CI'))
      .toEqual({ kind: 'runner', waitingSeconds: 120 });
  });

  it('graph keys disambiguate sibling nodes: build-test does not satisfy a need on build', () => {
    const graphKeys = ['ci', 'build', 'build-test'];
    // bare startsWith would let the completed build-test satisfy the `build` need
    const all = [
      queued({ name: 'ci' }),
      run({ name: 'build-test', completedAt: '2026-06-10T11:58:00Z' }),
    ];
    expect(classifyWait(all[0]!, all, ['build'], NOW, undefined, graphKeys))
      .toEqual({ kind: 'blocked', blockedOn: 'build' });
    // with the real `build` present, the need is satisfied by it alone
    const all2 = [...all, run({ name: 'build', completedAt: '2026-06-10T11:55:00Z' })];
    expect(classifyWait(all2[0]!, all2, ['build'], NOW, undefined, graphKeys))
      .toEqual({ kind: 'runner', waitingSeconds: 300 }); // anchored on build, not build-test
  });
});

describe('extractRunnerWaits', () => {
  const needsOf: Record<string, string[] | null> = {
    'static-checks / TypeScript': ['Prepare (prisma + packages)'],
    'static-checks / ESLint': ['Prepare (prisma + packages)'],
    'ci': ['static-checks /', 'build'],
    'Prepare (prisma + packages)': [],
  };
  const needsFor = (name: string) => needsOf[name] ?? null;

  it('emits wait = startedAt − max(needed completedAt) for started checks with complete needs', () => {
    const checks = [
      run({ name: 'Prepare (prisma + packages)', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'static-checks / TypeScript', startedAt: '2026-06-10T11:55:00Z',
        completedAt: '2026-06-10T11:59:00Z' }),
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([
      { name: 'static-checks / TypeScript', event: 'pull_request', waitSecs: 120,
        startedAt: '2026-06-10T11:55:00Z' },
    ]);
  });

  it('still-running started checks produce samples too (startedAt is the anchor)', () => {
    const checks = [
      run({ name: 'Prepare (prisma + packages)', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'static-checks / ESLint', status: 'IN_PROGRESS', conclusion: null,
        startedAt: '2026-06-10T11:54:00Z', completedAt: null }),
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([
      { name: 'static-checks / ESLint', event: 'pull_request', waitSecs: 60,
        startedAt: '2026-06-10T11:54:00Z' },
    ]);
  });

  it('skips checks without startedAt, unknown needs, and root jobs (empty needs)', () => {
    const checks = [
      run({ name: 'Prepare (prisma + packages)', completedAt: '2026-06-10T11:53:00Z' }), // root
      queued({ name: 'static-checks / TypeScript' }),                                    // not started
      run({ name: 'lighthouse', startedAt: '2026-06-10T11:55:00Z' }),                    // unmatched
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([]);
  });

  it('skips checks whose needed checks are missing or not yet completed', () => {
    const checks = [
      run({ name: 'Prepare (prisma + packages)', status: 'IN_PROGRESS', conclusion: null, completedAt: null }),
      run({ name: 'static-checks / TypeScript', startedAt: '2026-06-10T11:55:00Z' }),
      run({ name: 'ci', startedAt: '2026-06-10T11:59:00Z' }), // needs build — absent from the set
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([]);
  });

  it('keeps zero waits (same-second warm pickups) and filters negative/implausibly long (0 ≤ wait < 7200)', () => {
    const mk = (started: string) => [
      run({ name: 'Prepare (prisma + packages)', completedAt: '2026-06-10T08:00:00Z' }),
      run({ name: 'static-checks / TypeScript', startedAt: started }),
    ];
    expect(extractRunnerWaits(mk('2026-06-10T08:00:00Z'), needsFor))
      .toMatchObject([{ waitSecs: 0 }]);                                          // wait 0 — real sample
    expect(extractRunnerWaits(mk('2026-06-10T07:59:00Z'), needsFor)).toEqual([]); // negative
    expect(extractRunnerWaits(mk('2026-06-10T10:00:00Z'), needsFor)).toEqual([]); // 7200, excluded
    expect(extractRunnerWaits(mk('2026-06-10T09:59:59Z'), needsFor)).toHaveLength(1);
  });

  it('a foreign-workflow check never anchors a need when the rollup workflow is known', () => {
    const graphKeys = ['ci', 'deploy'];
    const nf = (n: string) => (n === 'deploy' ? ['ci'] : null);
    const checks = [
      run({ name: 'ci-gate', workflowName: 'Auto-merge PRs', completedAt: '2026-06-10T11:54:00Z' }),
      run({ name: 'deploy', workflowName: 'CI', startedAt: '2026-06-10T11:56:00Z' }),
    ];
    // ci-gate longest-matches the `ci` node but is foreign — need unsatisfied, no sample
    expect(extractRunnerWaits(checks, nf, undefined, graphKeys, 'CI')).toEqual([]);
    // the real rollup `ci` anchors (11:50 → 360s); ci-gate's later completion is ignored
    const withCi = [run({ name: 'ci', workflowName: 'CI', completedAt: '2026-06-10T11:50:00Z' }), ...checks];
    expect(extractRunnerWaits(withCi, nf, undefined, graphKeys, 'CI')).toEqual([
      { name: 'deploy', event: 'pull_request', waitSecs: 360, startedAt: '2026-06-10T11:56:00Z' },
    ]);
  });

  it('graph keys disambiguate sibling nodes: build-test never anchors a need on build', () => {
    const graphKeys = ['ci', 'build', 'build-test'];
    const nf = (n: string) => (n === 'ci' ? ['build'] : null);
    const checks = [
      run({ name: 'build-test', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'ci', startedAt: '2026-06-10T11:55:00Z' }),
    ];
    // without the real build in the set, the need is unsatisfied — no sample
    expect(extractRunnerWaits(checks, nf, undefined, graphKeys)).toEqual([]);
    // the real build anchors (11:50 → 300s); build-test's later completion is ignored
    const withBuild = [run({ name: 'build', completedAt: '2026-06-10T11:50:00Z' }), ...checks];
    expect(extractRunnerWaits(withBuild, nf, undefined, graphKeys)).toEqual([
      { name: 'ci', event: 'pull_request', waitSecs: 300, startedAt: '2026-06-10T11:55:00Z' },
    ]);
  });

  it('matches needed checks within the same event only', () => {
    const checks = [
      run({ name: 'Prepare (prisma + packages)', event: 'merge_group', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'static-checks / TypeScript', startedAt: '2026-06-10T11:55:00Z' }), // pull_request
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([]);
  });

  it('drops needs inactive for the check event and anchors on the remaining completion', () => {
    // ci needs ['static-checks /', 'build']; pretend 'build' is merge_group-only,
    // so it is absent from this pull_request set — sample still anchors on static-checks
    const checks = [
      run({ name: 'static-checks / TypeScript', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'ci', startedAt: '2026-06-10T11:55:00Z' }),
    ];
    const activeFor = (prefix: string, event: string) =>
      !(prefix === 'build' && event === 'pull_request');
    expect(extractRunnerWaits(checks, needsFor, activeFor)).toEqual([
      { name: 'ci', event: 'pull_request', waitSecs: 120, startedAt: '2026-06-10T11:55:00Z' },
    ]);
  });

  it('every need inactive for the event → no anchor, no sample', () => {
    const checks = [run({ name: 'ci', startedAt: '2026-06-10T11:55:00Z' })];
    expect(extractRunnerWaits(checks, needsFor, () => false)).toEqual([]);
  });

  it('SKIPPED needs are excluded from the anchor (unreliable placeholder timestamps)', () => {
    // the skipped need "completed" AFTER the dependent started (observed in the
    // wild) — including it would produce a negative wait and drop the sample
    const checks = [
      run({ name: 'static-checks / TypeScript', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'build', conclusion: 'SKIPPED', completedAt: '2026-06-10T11:56:00Z' }),
      run({ name: 'ci', startedAt: '2026-06-10T11:55:00Z' }),
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([
      { name: 'ci', event: 'pull_request', waitSecs: 120, startedAt: '2026-06-10T11:55:00Z' },
    ]);
  });

  it('SKIPPED needs without completedAt do not block anchoring on the others', () => {
    const checks = [
      run({ name: 'static-checks / TypeScript', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'build', conclusion: 'SKIPPED', completedAt: null }),
      run({ name: 'ci', startedAt: '2026-06-10T11:55:00Z' }),
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([
      { name: 'ci', event: 'pull_request', waitSecs: 120, startedAt: '2026-06-10T11:55:00Z' },
    ]);
  });

  it('all needs SKIPPED → no anchor, no sample', () => {
    const checks = [
      run({ name: 'static-checks / TypeScript', conclusion: 'SKIPPED', completedAt: '2026-06-10T11:53:00Z' }),
      run({ name: 'build', conclusion: 'SKIPPED', completedAt: '2026-06-10T11:54:00Z' }),
      run({ name: 'ci', startedAt: '2026-06-10T11:55:00Z' }),
    ];
    expect(extractRunnerWaits(checks, needsFor)).toEqual([]);
  });
});
