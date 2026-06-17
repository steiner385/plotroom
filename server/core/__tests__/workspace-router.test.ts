import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWorkspaceRouter } from '../api/workspace-router';
import { ModelDeriver, type ModelDeriveDeps } from '../model/derive';
import type { PrClient } from '../actions/draftPr';
import type { SuccessStat, FlakeStat } from '../../history';

const CI = `name: CI
on:
  pull_request:
  merge_group:
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps: [{ run: pnpm e2e }]
  ci:
    name: ci
    needs: [e2e]
    runs-on: ubuntu-latest
`;

let openDraftPr: ReturnType<typeof vi.fn>;
function app(headSeq?: string[]) {
  const heads = headSeq ?? ['sha-1'];
  let i = 0;
  const deps: ModelDeriveDeps = {
    resolveHeadSha: vi.fn(async () => heads[Math.min(i++, heads.length - 1)]),
    fetchWorkflowAtSha: vi.fn(async (_r, n) => (n === 'ci.yml' ? CI : null)),
    successStatsByRepo: () => new Map<string, SuccessStat[]>(),
    flakeStatsByRepo: () => new Map<string, FlakeStat[]>(),
    since: '2026-01-01T00:00:00Z',
  };
  const deriver = new ModelDeriver(deps);
  openDraftPr = vi.fn(async () => ({ number: 7, url: 'https://github.com/o/r/pull/7' }));
  const prClient: PrClient = {
    fetchWorkflowAtSha: deps.fetchWorkflowAtSha as unknown as PrClient['fetchWorkflowAtSha'],
    openDraftPr: openDraftPr as unknown as PrClient['openDraftPr'],
  };
  const a = express();
  a.use(express.json());
  a.use('/api/workspace', createWorkspaceRouter({ deriver, prClient }));
  return a;
}

describe('workspace-router (integration, contracts/api.md)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /pipeline returns the SHA-pinned model', async () => {
    const res = await request(app()).get('/api/workspace/pipeline?repo=o/r');
    expect(res.status).toBe(200);
    expect(res.body.sourceSha).toBe('sha-1');
    expect(res.body.model.checks).toContain('e2e');
  });

  it('400 on a malformed repo', async () => {
    expect((await request(app()).get('/api/workspace/pipeline?repo=bad')).status).toBe(400);
  });

  it('POST /simulate returns a legality-bound projection', async () => {
    const res = await request(app()).post('/api/workspace/simulate')
      .send({ repo: 'o/r', move: { check: 'e2e', fromTierId: 'queue', toTierId: null } });
    expect(res.status).toBe(200);
    expect(res.body.legal).toBe(false); // e2e is the required merge gate
    expect(res.body.reason).toBe('required-gate');
  });

  it('POST /draft-pr dryRun returns a diff preview without opening a PR', async () => {
    const res = await request(app()).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: true, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' } });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.diff).toMatch(/merge_group/);
    expect(openDraftPr).not.toHaveBeenCalled();
  });

  it('POST /draft-pr (dryRun:false) opens a draft PR when HEAD is stable', async () => {
    const res = await request(app()).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: false, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ opened: true, number: 7, url: 'https://github.com/o/r/pull/7' });
  });

  it('POST /draft-pr 409s an illegal intent (required-gate)', async () => {
    const res = await request(app()).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: false, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'queue', targetEvent: 'push' } });
    expect(res.status).toBe(409);
  });

  it('POST /draft-pr 409s with headSha when HEAD drifts (FR-026)', async () => {
    const res = await request(app(['sha-1', 'sha-2'])).post('/api/workspace/draft-pr')
      .send({ repo: 'o/r', dryRun: false, intent: { kind: 'tier', check: 'e2e', jobId: 'e2e', fromTierId: 'pr', targetEvent: 'merge_group' } });
    expect(res.status).toBe(409);
    expect(res.body.headSha).toBe('sha-2');
    expect(openDraftPr).not.toHaveBeenCalled();
  });
});
