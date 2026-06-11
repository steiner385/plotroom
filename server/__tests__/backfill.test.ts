import { describe, it, expect, vi } from 'vitest';
import { backfillRepo } from '../backfill';
import { HistoryStore } from '../history';

const PAGE = (hasNext: boolean, cursor: string | null) => ({
  repository: { defaultBranchRef: { name: 'main', target: { history: {
    pageInfo: { hasNextPage: hasNext, endCursor: cursor },
    nodes: [{ oid: 'c1', statusCheckRollup: { contexts: { nodes: [{
      __typename: 'CheckRun', name: 'TypeScript', status: 'COMPLETED', conclusion: 'SUCCESS',
      startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:03:00Z',
      checkSuite: { workflowRun: { event: 'push' } },
    }] } } }],
  } } } },
});

describe('backfillRepo', () => {
  it('pages history, ingests SUCCESS durations, stops at maxPages', async () => {
    const history = new HistoryStore(':memory:');
    const client = { graphql: vi.fn()
      .mockResolvedValueOnce(PAGE(true, 'CUR'))
      .mockResolvedValueOnce(PAGE(false, null)) };
    await backfillRepo(client as never, history, 'acme/widgets', 5);
    expect(client.graphql).toHaveBeenCalledTimes(2);
    expect(history.expected('acme/widgets', 'TypeScript', 'push')).not.toBeNull();
  });

  it('ingests runner-wait samples when a needsFor resolver is provided (W2)', async () => {
    const page = {
      repository: { defaultBranchRef: { name: 'main', target: { history: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ oid: 'c1', statusCheckRollup: { contexts: { nodes: [
          { __typename: 'CheckRun', name: 'Prepare', status: 'COMPLETED', conclusion: 'SUCCESS',
            startedAt: '2026-06-10T10:00:00Z', completedAt: '2026-06-10T10:02:00Z',
            checkSuite: { workflowRun: { event: 'push' } } },
          { __typename: 'CheckRun', name: 'TypeScript', status: 'COMPLETED', conclusion: 'SUCCESS',
            startedAt: '2026-06-10T10:03:00Z', completedAt: '2026-06-10T10:06:00Z',
            checkSuite: { workflowRun: { event: 'push' } } },
        ] } } }],
      } } } },
    };
    const history = new HistoryStore(':memory:');
    const client = { graphql: vi.fn().mockResolvedValueOnce(page) };
    const needsFor = (name: string) =>
      name === 'TypeScript' ? ['Prepare'] : name === 'Prepare' ? [] : null;
    await backfillRepo(client as never, history, 'acme/widgets', 5, needsFor);
    // TypeScript started 10:03, its need completed 10:02 → 60s pickup wait
    expect(history.expectedRunnerWait('acme/widgets', 'TypeScript', 'push')).toBe(60);
    expect(history.expectedRunnerWait('acme/widgets', 'Prepare', 'push')).toBeNull();
  });
});
