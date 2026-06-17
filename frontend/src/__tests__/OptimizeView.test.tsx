import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OptimizeView } from '../sections/optimize/OptimizeView';
import type { WorkspaceApi } from '../shell/workspaceApi';
import type { DerivedModelLike } from '../sections/optimize/types';

const MODEL: DerivedModelLike = {
  tiers: [{ id: 'pr', label: 'PR', event: 'pull_request' }, { id: 'queue', label: 'Queue', event: 'merge_group' }],
  checks: ['e2e', 'build'],
  cells: [
    { check: 'e2e', tierId: 'pr', intent: { runs: true, gates: false, conditional: false }, observed: { runs: 100, minutes: 5000, realFailures: 0, flakeRatePct: 0 }, state: 'advisory' },
    { check: 'build', tierId: 'queue', intent: { runs: true, gates: true, conditional: false }, observed: null, state: 'gate' },
  ],
  checkMeta: [
    { check: 'e2e', isRequiredMergeGate: false, provenance: [{ file: 'e2e.yml', jobId: 'e2e' }] },
    { check: 'build', isRequiredMergeGate: true, provenance: [{ file: 'ci.yml', jobId: 'build' }] },
  ],
};

function fakeApi(over: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    getPipeline: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', model: MODEL })),
    simulate: vi.fn(async (_r, m) => m.check === 'build'
      ? { legal: false, reason: 'required-gate', note: 'not possible — required merge gate', costDeltaMinutes: 0, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false }
      : { legal: true, note: 'saves 5,000 min', costDeltaMinutes: -5000, direction: 'remove', gatesLost: [], gatesGained: [], estimated: false }),
    prompt: vi.fn(async () => ({ prompt: 'do the thing' })),
    draftPrDryRun: vi.fn(async () => ({ dryRun: true as const, diff: '@@ e2e → merge_group @@', baseSha: 'abc' })),
    draftPrOpen: vi.fn(async () => ({ opened: true as const, number: 5, url: 'u' })),
    security: vi.fn(async () => ({ repo: 'o/r', sourceSha: 's', scannedFiles: 0, findings: [] })),
    self: vi.fn(async () => ({ ingestionFreshnessSecs: 0, derivationCache: { hits: 0, misses: 0, hitRate: 0, size: 0 }, apiRateLimit: null, status: 'ok' as const, reasons: [] })),
    ruleset: vi.fn(async () => ({ readable: true, derivedRequired: [], liveRequired: [], missingFromModel: [], extraInModel: [], inSync: true })),
    forecast: vi.fn(async () => ({ available: false })),
    changelog: vi.fn(async () => ({ changelog: [], audit: [] })),
    outcomes: vi.fn(async () => ({ outcomes: [], accuracy: { count: 0, meanCostAccuracy: 0, directionHitRate: 0, recommenderUsable: false } })),
    budgets: vi.fn(async () => ({ gauges: [], alerts: [] })),
    policy: vi.fn(async () => ({ rules: [], violations: [] })),
    quarantineDryRun: vi.fn(async (_r: string, check: string) => {
      if (check === 'build') throw new Error('"build" is a required merge gate — cannot quarantine it');
      return { dryRun: true as const, diff: '@@ e2e quarantine — continue-on-error @@', baseSha: 'abc' };
    }),
    ...over,
  };
}

describe('OptimizeView (US4 — drives /api/workspace loop)', () => {
  it('loads the model and lists checks', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    expect(await screen.findByText('e2e')).toBeInTheDocument();
    expect(screen.getByText('build')).toBeInTheDocument();
  });

  it('simulating a legal demote shows the saving + offers a draft-PR preview', async () => {
    const api = fakeApi();
    render(<OptimizeView repo="o/r" api={api} />);
    fireEvent.click((await screen.findAllByText('Simulate demote'))[0]); // e2e
    expect(await screen.findByText(/saves 5,000 min/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Preview draft PR'));
    expect(await screen.findByLabelText('draft PR diff')).toHaveTextContent('e2e → merge_group');
  });

  it('a required-gate demote is shown as blocked (no preview button)', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const buttons = await screen.findAllByText('Simulate demote');
    fireEvent.click(buttons[1]); // build (required gate)
    expect(await screen.findByText(/not possible — required merge gate/)).toBeInTheDocument();
    expect(screen.queryByText('Preview draft PR')).not.toBeInTheDocument();
  });

  it('quarantine (K2): previews the diff for a flaky non-gate', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const btns = await screen.findAllByText('Quarantine (flaky)');
    fireEvent.click(btns[0]); // e2e (not a required gate)
    expect(await screen.findByLabelText('quarantine diff')).toHaveTextContent('continue-on-error');
  });

  it('quarantine (K2): shows the server refusal for a required merge gate (FR-038)', async () => {
    render(<OptimizeView repo="o/r" api={fakeApi()} />);
    const btns = await screen.findAllByText('Quarantine (flaky)');
    fireEvent.click(btns[1]); // build (required gate)
    expect(await screen.findByText(/Can’t quarantine build/)).toHaveTextContent(/required merge gate/);
  });

  it('surfaces a load error', async () => {
    const api = fakeApi({ getPipeline: vi.fn(async () => { throw new Error('no derivable model'); }) });
    render(<OptimizeView repo="o/r" api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no derivable model');
  });
});
