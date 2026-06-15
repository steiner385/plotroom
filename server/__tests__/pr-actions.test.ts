import { describe, it, expect, vi } from 'vitest';
import { readyAndAutoMerge, PermissionError, type GraphqlClient } from '../pr-actions';

interface PrState {
  id?: string;
  isDraft?: boolean;
  state?: string;
  mergeStateStatus?: string | null;
  armed?: boolean;
}

function fakeClient(pr: PrState | null, opts: { readyError?: string; enableError?: string } = {}) {
  const calls: { kind: string; vars: Record<string, unknown> }[] = [];
  const graphql = vi.fn(async (query: string, vars: Record<string, unknown> = {}) => {
    if (query.includes('pullRequest(number')) {
      calls.push({ kind: 'lookup', vars });
      return {
        repository: pr == null ? { pullRequest: null } : {
          pullRequest: {
            id: pr.id ?? 'PR_node1',
            isDraft: pr.isDraft ?? false,
            state: pr.state ?? 'OPEN',
            mergeStateStatus: pr.mergeStateStatus ?? 'BLOCKED',
            autoMergeRequest: pr.armed ? { __typename: 'AutoMergeRequest' } : null,
          },
        },
      };
    }
    if (query.includes('markPullRequestReadyForReview')) {
      calls.push({ kind: 'markReady', vars });
      if (opts.readyError) throw new Error(opts.readyError);
      return { markPullRequestReadyForReview: { pullRequest: { id: vars.id, isDraft: false } } };
    }
    if (query.includes('enablePullRequestAutoMerge')) {
      calls.push({ kind: 'enable', vars });
      if (opts.enableError) throw new Error(opts.enableError);
      return { enablePullRequestAutoMerge: { pullRequest: { id: vars.id, mergeStateStatus: 'BLOCKED' } } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  });
  return { graphql, calls } as { graphql: GraphqlClient['graphql']; calls: typeof calls };
}

const INPUT = { owner: 'acme', repo: 'widgets', number: 42 };

describe('readyAndAutoMerge', () => {
  it('marks a draft ready and arms auto-merge with the default SQUASH method', async () => {
    const c = fakeClient({ isDraft: true });
    const r = await readyAndAutoMerge(c, INPUT);
    expect(r).toMatchObject({ markedReady: true, autoMergeArmed: true, alreadyArmed: false, cleanReadyToMerge: false });
    expect(c.calls.map((x) => x.kind)).toEqual(['lookup', 'markReady', 'enable']);
    expect(c.calls.find((x) => x.kind === 'enable')!.vars.method).toBe('SQUASH');
  });

  it('skips the ready step for a non-draft PR (only arms auto-merge)', async () => {
    const c = fakeClient({ isDraft: false });
    const r = await readyAndAutoMerge(c, INPUT);
    expect(r.markedReady).toBe(false);
    expect(c.calls.map((x) => x.kind)).toEqual(['lookup', 'enable']);
  });

  it('skips the enable step when auto-merge is already armed', async () => {
    const c = fakeClient({ isDraft: true, armed: true });
    const r = await readyAndAutoMerge(c, INPUT);
    expect(r).toMatchObject({ markedReady: true, autoMergeArmed: true, alreadyArmed: true });
    expect(c.calls.map((x) => x.kind)).toEqual(['lookup', 'markReady']);
  });

  it('honors a non-default merge method', async () => {
    const c = fakeClient({ isDraft: true });
    await readyAndAutoMerge(c, { ...INPUT, mergeMethod: 'REBASE' });
    expect(c.calls.find((x) => x.kind === 'enable')!.vars.method).toBe('REBASE');
  });

  it('throws when the PR is not found', async () => {
    const c = fakeClient(null);
    await expect(readyAndAutoMerge(c, INPUT)).rejects.toThrow(/not found/);
  });

  it('refuses a non-OPEN PR', async () => {
    const c = fakeClient({ state: 'MERGED' });
    await expect(readyAndAutoMerge(c, INPUT)).rejects.toThrow(/not OPEN/);
  });

  it('reports cleanReadyToMerge when auto-merge is rejected for a clean PR', async () => {
    const c = fakeClient({ isDraft: true }, { enableError: 'Pull request is in clean status' });
    const r = await readyAndAutoMerge(c, INPUT);
    expect(r).toMatchObject({ markedReady: true, autoMergeArmed: false, cleanReadyToMerge: true });
  });

  it('maps a FORBIDDEN GraphQL error to a PermissionError', async () => {
    const c = fakeClient({ isDraft: false },
      { enableError: 'GraphQL errors: Resource not accessible by integration' });
    await expect(readyAndAutoMerge(c, INPUT)).rejects.toBeInstanceOf(PermissionError);
  });
});
