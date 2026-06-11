import { describe, it, expect } from 'vitest';
import { canonicalizeCheckName, dedupeChecks } from '../normalize';
import type { CheckRun } from '../types';

const run = (over: Partial<CheckRun>): CheckRun => ({
  name: 'x', rawName: 'x', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:05:00Z',
  event: 'pull_request', workflowName: null, runNumber: null, isRequired: true, url: null, ...over,
});

describe('canonicalizeCheckName', () => {
  it('normalizes un-interpolated matrix placeholders', () => {
    expect(canonicalizeCheckName('static-checks / Unit Tests (${{ matrix.shard }}/8)'))
      .toBe('static-checks / Unit Tests (shard/8)');
  });
  it('normalizes expanded shard names to the same family', () => {
    expect(canonicalizeCheckName('static-checks / Unit Tests (3/8)'))
      .toBe('static-checks / Unit Tests (shard/8)');
    expect(canonicalizeCheckName('Integration Tests (1/3)')).toBe('Integration Tests (shard/3)');
  });
  it('leaves plain names alone', () => {
    expect(canonicalizeCheckName('fast-checks / ESLint')).toBe('fast-checks / ESLint');
  });
});

describe('dedupeChecks', () => {
  it('separates same-named jobs from different workflows (workflowName in the key)', () => {
    const out = dedupeChecks([
      run({ name: 'ci', workflowName: 'CI', startedAt: '2026-06-10T09:00:00Z' }),
      run({ name: 'ci', workflowName: 'Auto-merge PRs', startedAt: '2026-06-10T09:01:00Z' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.workflowName).sort()).toEqual(['Auto-merge PRs', 'CI']);
  });

  it('null workflowName groups together (old data keeps the pre-workflow key)', () => {
    const out = dedupeChecks([
      run({ name: 'ci', workflowName: null, startedAt: '2026-06-10T09:00:00Z' }),
      run({ name: 'ci', workflowName: null, startedAt: '2026-06-10T09:30:00Z', conclusion: 'FAILURE' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.conclusion).toBe('FAILURE');
  });

  it('keeps latest startedAt per (name, event), separates events', () => {
    const out = dedupeChecks([
      run({ name: 'TypeScript', event: 'push', startedAt: '2026-06-10T09:00:00Z' }),
      run({ name: 'TypeScript', event: 'merge_group', startedAt: '2026-06-10T09:01:00Z' }),
      run({ name: 'TypeScript', event: 'merge_group', startedAt: '2026-06-10T09:30:00Z', conclusion: 'FAILURE' }),
    ]);
    expect(out).toHaveLength(2);
    const mg = out.find((c) => c.event === 'merge_group')!;
    expect(mg.conclusion).toBe('FAILURE');
  });

  it('real-timestamp wins over null startedAt regardless of array order', () => {
    const real = run({ name: 'Build', event: 'pull_request', startedAt: '2026-06-10T10:00:00Z', conclusion: 'SUCCESS' });
    const nullStart = run({ name: 'Build', event: 'pull_request', startedAt: null, conclusion: 'FAILURE' });

    // null-first order
    const out1 = dedupeChecks([nullStart, real]);
    expect(out1).toHaveLength(1);
    expect(out1[0].conclusion).toBe('SUCCESS');

    // real-first order
    const out2 = dedupeChecks([real, nullStart]);
    expect(out2).toHaveLength(1);
    expect(out2[0].conclusion).toBe('SUCCESS');
  });
});
